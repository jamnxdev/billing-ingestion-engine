# Benchmarks

Three independent benchmarks live in `packages/bench`, each isolating one variable.
All results below are **first-run numbers on a single, shared development machine**,
committed as raw data under [`packages/bench/results/`](../packages/bench/results/).
They have **not** yet been repeated across multiple independent runs or measured on a
dedicated (non-shared) host — treat outlier/tail figures (max latency, P99 spikes)
with that caveat in mind. Re-running and updating this document with a dedicated-host
result is tracked as follow-up work, not done yet.

## Reproducing these results

```bash
npm install
npm run build --workspaces
./packages/bench/run-correctness-suite.sh          # correctness table
npm run throughput --workspace=packages/bench      # throughput sweep
npm run dedup-latency --workspace=packages/bench   # dedup lookup latency
```

Each writes/overwrites its CSV under `packages/bench/results/`.

## 1. Correctness vs. duplicate rate

**Question:** how much does idempotency-key dedup actually buy, measured as exact-match
billing accuracy, as the rate of duplicate submissions increases?

**Method:** for each duplicate rate in `{0%, 10%, 50%, 90%}`, 20 trials, each with 200
fresh ground-truth events (`packages/testclient`) and a fresh, independently-seeded
adversarial stream (duplication + reordering) submitted through **both**
`buildServer` (dedup) and `buildNaiveServer` (no dedup) — same stream, both designs,
each built fresh per trial so no state leaks between trials. `matches` is an **exact**
equality check between the queried total and the offline-computed ground truth, per
the project's own correctness methodology (a correctness claim, not a tolerance band).

**Results** (`packages/bench/results/correctness-summary.csv`):

| Duplicate rate | Design | Trials | Matches | Correctness rate |
|---:|---|---:|---:|---:|
| 0% | correct | 20 | 20 | **100.0%** |
| 0% | naive | 20 | 20 | 100.0% |
| 10% | correct | 20 | 20 | **100.0%** |
| 10% | naive | 20 | 0 | **0.0%** |
| 50% | correct | 20 | 20 | **100.0%** |
| 50% | naive | 20 | 0 | **0.0%** |
| 90% | correct | 20 | 20 | **100.0%** |
| 90% | naive | 20 | 0 | **0.0%** |

The correct design holds 100% accuracy at every tested duplicate rate — dedup
correctness depends only on whether a duplicate falls inside or outside the bounded
window, never on duplicate *rate* itself. The naive design's correctness collapses to
0% the instant any duplicates exist (an exact-match metric has no partial credit — even
one mis-attributed unit fails the trial), but the more informative number is how far
off it actually is:

**Over-billing magnitude** (from `correctness-raw.csv`, representative example at 90%
duplicate rate): naive billed **18,457** units against a true **9,749** units — **89.3%
over-billed**. At 10%, naive over-billing ranges roughly 6–19% per trial; at 50%,
roughly 42–60% per trial. Over-billing scales with duplicate rate, as expected —
the raw per-trial CSV has every individual data point.

### Late duplicate, beyond the window

**Question:** what happens to a retry that arrives *after* the dedup window has
already elapsed? (Direct test of the bounded-window tradeoff — see
[`DECISIONS.md`](DECISIONS.md#bounded-dedup-window).)

**Method:** a single deterministic scenario — an event is submitted, then a fake clock
is jumped directly from `0` to `dedupWindowMs + 1`, then an identical retry is
submitted.

**Result** (`packages/bench/results/late-duplicate-scenario.json`):

```json
{
  "dedupWindowMs": 300000,
  "originalQuantity": 10,
  "duplicateQuantity": 10,
  "correctTotalIfWithinWindow": 10,
  "actualTotal": 20,
  "duplicateWasRecognizedAsSuch": false
}
```

The retry is **not** recognized as a duplicate and is billed again (total `20`, not
`10`). This is the direct, demonstrated answer to "what happens when a retry arrives
very late" — a bounded window necessarily has an "outside the window" case by
definition; the alternative (unbounded dedup storage) was rejected as unrealistic from
the start. Not a bug — a documented, tested boundary.

## 2. Throughput vs. concurrency

**Question:** what does correctness (auth + rate limiting + dedup + synchronous
aggregation) cost in raw throughput and latency?

**Method:** real HTTP over Node's built-in `fetch` (not in-process `inject()` —
throughput is fundamentally about I/O and connection handling, which in-process
injection bypasses). `buildServer` is `listen()`'d on an OS-assigned port and closed
after each concurrency level (fresh state per level). Concurrency levels
`{1, 5, 20, 50, 100}`, each with a 500ms excluded warmup followed by 2000ms measured;
every concurrent worker submits unique events for the duration (clean load — no
duplicates injected here; that's the correctness benchmark's job). Percentiles use the
nearest-rank method over a sorted sample array.

**Results** (`packages/bench/results/throughput.csv`):

| Concurrency | Throughput (req/s) | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | Post-load `GET /aggregates` (ms) |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 5,099 | 0.17 | 0.26 | 0.37 | 12.04 | 1.34 |
| 5 | 6,438 | 0.70 | 0.91 | 2.67 | 10.42 | 0.44 |
| 20 | 6,852 | 2.62 | 3.64 | 9.91 | 13.03 | 0.21 |
| 50 | 7,145 | 6.28 | 13.27 | 15.28 | 20.63 | 0.31 |
| 100 | 7,041 | 12.82 | 21.39 | 25.13 | 199.73 | 0.25 |

Throughput rises with concurrency then plateaus around **~7,000 req/s** (single
process, single dev machine, no clustering); latency grows roughly linearly with
concurrency past that point — the expected queueing-delay signature of a saturating
single-process server, not a correctness concern.

The last column is the direct, measured evidence for the "near-zero aggregation lag"
design claim (accepted events are applied synchronously, in-request — see
[`ARCHITECTURE.md`](ARCHITECTURE.md)): a `GET /aggregates` call issued immediately
after load stops stays in the sub-millisecond-to-low-single-digit-ms range at every
concurrency level, because there is no separate materialization step to wait on.

The concurrency-100 max-latency spike (199.73ms, a clear outlier against everything
else in that column) hasn't been root-caused yet — most likely a GC pause or
event-loop contention on a shared dev machine, flagged as a follow-up for a
profiler-equipped run rather than silently smoothed over.

**Not unit-tested**, deliberately: this benchmark's output is a timing measurement,
not a correctness claim — proven correct by code inspection plus the real run above,
the same treatment given to any pure timing harness in this project (contrast with
`CorrectnessBenchmark`, which *is* unit-tested, because its output *is* a correctness
claim).

## 3. Dedup-store lookup latency vs. window size

**Question:** does `DedupStore.check()` get slower as the configured dedup window
grows? (Direct test of the O(1)-amortized-eviction design claim — see
[`DECISIONS.md`](DECISIONS.md#bounded-dedup-window).)

**Method:** isolates **window size** as the single controlled variable by holding
**occupancy** (live entry count) fixed at a target (10,000) across every window size
tested — window size and occupancy are two different things that could plausibly both
affect lookup cost, and conflating them would answer the wrong question. The tick
between simulated events scales with `windowMs / targetOccupancy`, so reaching
steady-state occupancy takes the same number of warmup calls regardless of window
size — measured via a fake clock, so a 1-hour window is measurable in milliseconds of
real wall-clock time.

**Results** (`packages/bench/results/dedup-latency.csv`, 20,000 measured calls per
window size):

| Window size | Occupancy | p50 (μs) | p95 (μs) | p99 (μs) | max (μs) |
|---|---:|---:|---:|---:|---:|
| 1 second | 10,001 | 0.48 | 1.86 | 2.77 | 1,077.27 |
| 1 minute | 10,000 | 0.47 | 1.79 | 2.43 | 1,138.66 |
| 5 minutes | 10,000 | 0.48 | 1.69 | 26.47 | 2,081.26 |
| 1 hour | 10,000 | 0.68 | 2.21 | 3.09 | 436.38 |

p50/p95 stay essentially flat (sub-2μs) across a window-size range spanning **three
full orders of magnitude** (1 second to 1 hour) — confirming lookup cost is governed by
**occupancy**, not window size, matching the amortized-O(1)-eviction design (every
entry shares one window, so entries expire in exactly insertion order — see
[`DECISIONS.md`](DECISIONS.md#bounded-dedup-window)). The occasional P99/max spike
(tens to low thousands of μs) is consistent with GC pauses on a shared dev machine —
not investigated further yet, same follow-up caveat as the throughput benchmark above.

**Structural tests only** (`DedupLatencyBenchmark.test.ts`) — result count matches
configured window sizes, occupancy actually reaches and holds the target regardless of
window size (the scaling math this benchmark's fairness depends on), and the requested
measured-call count is honored. Latency *values* are deliberately left untested, same
reasoning as the throughput benchmark.

## Caveats that apply to every number on this page

- Single, shared development machine — not a dedicated or isolated benchmark host.
- First-run numbers, not yet repeated across independent processes/machines to check
  run-to-run variance.
- Outlier/tail figures (max, and occasional P99 spikes) are plausibly explained by GC
  pauses or scheduling noise on a shared machine, but this has not been confirmed with
  a profiler.
- Numbers reflect a single Fastify process with no clustering, load balancing, or
  horizontal scaling — a deployed, multi-process/multi-instance configuration would be
  expected to scale throughput further, but that hasn't been measured (no deployment
  exists yet — see [Known Limitations](../README.md#known-limitations)).
