# Architecture

This document explains how the system fits together and *why* it's shaped this way —
if you just want the API contract, see [`API.md`](API.md); for the reasoning behind
individual tradeoffs, see [`DECISIONS.md`](DECISIONS.md).

## Goals, in order

1. **Never double-count.** The same logical event, submitted more than once (a retry,
   a client bug, a proxy replay), must be billed exactly once.
2. **Never depend on arrival order.** Two clients submitting the same set of events in
   different orders must produce identical totals.
3. **Fail loudly on ambiguity.** If a client reuses an idempotency key for what looks
   like a different event, that's a client bug — surface it, don't guess.
4. Only after 1–3 are satisfied: be fast.

Everything below is a consequence of taking those four, in that order, seriously.

## Data flow

```
Client
  │  POST /events { tenantId, idempotencyKey, metric, quantity, occurredAtMs }
  ▼
┌─────────────────────────────────────────────────────────────────────┐
│ packages/ingest — Fastify HTTP API                                   │
│                                                                        │
│  1. preValidation hook:  x-api-key → tenant?  ──no──▶ 401             │
│  2. Fastify JSON Schema:  body well-formed?    ──no──▶ 400             │
│  3. preHandler hook:      authenticated tenant                        │
│                            == body.tenantId?    ──no──▶ 403 mismatch   │
│                           TokenBucket.tryConsume(tenant) ─no─▶ 429     │
│  4. handler:                                                          │
│       hash = payloadHash(event)          (business fields only)       │
│       outcome = DedupStore.check(tenantId, idempotencyKey, hash)      │
│                                                                        │
│       outcome ─── "new" ──────▶ aggregator.record(event) ──▶ 202      │
│               ─── "duplicate" ─────────────────────────────▶ 200      │
│               ─── "conflict" ──────────────────────────────▶ 409      │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│ packages/aggregator — SlidingWindowAggregator                        │
│   Map<tenantId, Map<metric, Map<bucketStartMs, quantity>>>            │
│   bucketStartMs = floor(event.occurredAtMs / bucketSizeMs) * bucketSizeMs │
└─────────────────────────────────────────────────────────────────────┘
                                    ▲
                                    │  read, synchronously up to date
Client  ── GET /aggregates/:tenantId?metric=… ────────────────────────┘
```

Every accepted event is applied to the aggregator **synchronously, in the same
request**, before the `202` is returned. There is no queue, no batching, no
asynchronous "materialization" step between ingestion and query — the tradeoffs of
that choice are covered in [`DECISIONS.md`](DECISIONS.md#synchronous-in-request-aggregation).

## Component responsibilities

### `packages/aggregator` — the core domain

Deliberately has **zero HTTP dependency**. It owns:

- `UsageEvent` — the domain type (`tenantId`, `idempotencyKey`, `metric`, `quantity`,
  `occurredAtMs`) and its Fastify JSON Schema, defined in the same file so the two can
  never silently drift apart.
- `SlidingWindowAggregator` — per-tenant, per-metric **cumulative running totals**,
  bucketed by each event's own `occurredAtMs`. "Sliding-window" here means *bucketed
  for exact attribution*, not *a rolling window relative to now* — a billing total must
  never shrink as time passes, so nothing is ever evicted from it. See
  [`DECISIONS.md`](DECISIONS.md#cumulative-totals-not-a-rolling-window) for why that
  distinction mattered enough to confirm explicitly rather than assume.

Because it has no HTTP dependency, `packages/testclient` and `packages/bench` also
depend directly on it — both need the same domain type and, in bench's case, an
aggregator instance to compute ground-truth totals against.

### `packages/ingest` — the transport layer

Everything HTTP-shaped lives here, layered on top of `aggregator`:

- **`DedupStore`** — idempotency-key deduplication, scoped per tenant, bounded by a
  fixed time window. See [API.md](API.md#dedup-semantics) for the three outcomes
  (`new`/`duplicate`/`conflict`) and [DECISIONS.md](DECISIONS.md#bounded-dedup-window)
  for why the window is bounded and anchored to first-seen (not last-seen) time.
- **`TokenBucket`** — a standard per-key token bucket used for per-tenant rate
  limiting, with lazily-computed refill (no background timer) — the same "derive from
  elapsed time against an injectable clock" pattern `DedupStore`'s eviction uses.
- **`buildServer(options)`** — wires auth, rate limiting, dedup, and aggregation into
  a Fastify instance. Deliberately *constructs but does not `listen()`* — see
  [Testing strategy](#testing-strategy) for why that separation exists.
- **`buildNaiveServer(options)`** — the same route shape, minus the dedup layer: every
  well-formed request is accepted and applied, including exact resubmissions. This is
  the direct A/B comparison point the correctness benchmark uses — not an artificially
  crippled strawman, just `buildServer` with its one defining feature removed, so the
  benchmark measures exactly what dedup buys and nothing else.

### `packages/testclient` — reproducible adversarial load

- **`generateGroundTruth`** — a deterministic, seeded generator (a small
  dependency-free `Mulberry32` PRNG) producing a "true" set of usage events with
  globally unique idempotency keys.
- **`buildAdversarialStream`** — takes that ground truth and a
  `{ seed, duplicateRate, reorder }` config, and produces the actual stream of
  requests to submit: each event independently duplicated with probability
  `duplicateRate` (a Bernoulli trial per event, not an exact quota), and optionally
  shuffled into a random submission order (a seeded Fisher–Yates permutation, not a
  relabeling — same multiset of events, different order). *Delay* is deliberately not
  simulated as a literal wall-clock wait; see
  [DECISIONS.md](DECISIONS.md#delay-modeled-via-injectable-clock-not-real-waiting).

Because everything here is seeded, any specific run — including a failing one — is
exactly reproducible from its seed alone.

### `packages/bench` — the measurement layer

Three independent benchmarks, each answering one question:

| Benchmark | Question | Method |
|---|---|---|
| `CorrectnessBenchmark` | How much does dedup actually buy, in billing accuracy, as duplicate rate increases? | Runs the same adversarial stream through both `buildServer` and `buildNaiveServer`, compares the queried total against the independently-computed ground truth, exact match required. |
| `ThroughputBenchmark` | What does correctness cost in req/s and latency? | Real HTTP (`fetch`, a listening server on an OS-assigned port) at increasing concurrency levels, with a warmup period excluded from measurement. |
| `DedupLatencyBenchmark` | Does `DedupStore.check()` slow down as the configured window grows? | Holds live-entry *occupancy* fixed at a target while varying *window size*, isolating window size as the one controlled variable. |

`CorrectnessBenchmark` is unit-tested (its output is the project's headline
correctness claim — a bug here could silently produce a wrong table); the throughput
and dedup-latency benchmarks are pure timing tools and are not (a timing number isn't
itself a correctness claim a test could meaningfully check). See
[`BENCHMARKS.md`](BENCHMARKS.md) for full methodology and results.

## Testing strategy

- **Unit tests** exercise `DedupStore`, `payloadHash`, `SlidingWindowAggregator`, and
  `TokenBucket` directly, with zero HTTP involved and an injectable clock so
  window/refill/eviction behavior is deterministic (no `sleep()`-based flakiness
  anywhere in the suite).
- **HTTP-level tests** drive the Fastify API via `app.inject()` — no real socket, no
  port conflicts, fully in-process. `buildServer` is deliberately separate from its
  `listen()` entrypoint (`start.ts`) specifically so tests can do this.
- **Property-based tests** (via `fast-check`) generate randomized event sets and
  randomized submission orders, asserting both the final total *and* the per-bucket
  breakdown are identical regardless of order — a stronger claim than "the totals
  happen to match," since it rules out two different bucket distributions coincidentally
  summing to the same number.
- **Full-HTTP-path property tests** repeat the order-independence property against the
  actual ingestion API (not just the aggregator in isolation), proving the
  dedup-then-aggregate *wiring* is order-independent too, not just each piece alone.
- **Benchmarks that make a correctness claim are unit-tested**; pure timing harnesses
  are proven correct by inspection plus a real run, since a timing measurement isn't a
  correctness assertion a test could check.

Run everything: `npm run test --workspaces`. Run one package:
`npm run test --workspace=packages/<name>`.

## What's intentionally not built yet

See [Known Limitations](../README.md#known-limitations) in the README for the current
list, and [`DECISIONS.md`](DECISIONS.md) for the reasoning behind each one. In short:
no durable event log (in-memory state only), no read-side tenant auth on
`GET /aggregates`, no deployment automation.
