# Design Decisions

The reasoning behind the non-obvious choices in this codebase — written so a reader
never has to reverse-engineer *why* from the code alone. Each section names the
tradeoff, what was chosen, and why the alternative was rejected.

## Cumulative totals, not a rolling window

**Choice:** `SlidingWindowAggregator` maintains a cumulative running total per
tenant+metric, bucketed by event time for exact attribution. It is **not** a rolling
window relative to "now" (rate-limiter style), where old usage ages out and the total
can shrink.

**Why:** the term "sliding-window aggregation" is genuinely ambiguous between those two
systems, and they have materially different correctness properties. A billing total
that could shrink as time passes doesn't match the billing domain — you bill for total
usage, not "usage in the last 5 minutes." Bucketing is purely the mechanism for exact,
replay-stable attribution of each event to a single point in time, never a
retention/eviction boundary.

**Consequence:** no bucket is ever evicted. Per-tenant/per-metric bucket-map memory
grows without bound over a process's lifetime — an explicitly accepted limitation
(see [Unbounded bucket growth](#unbounded-bucket-growth-vs-zero-attribution-loss)
below), not an oversight.

## Bounded dedup window

**Choice:** `DedupStore` tracks idempotency keys within a fixed, bounded time window,
not indefinitely. The window is anchored to **first-seen** time — checking a key again
(as a duplicate or a conflict) does **not** extend its expiry.

**Why unbounded storage was rejected:** tracking every idempotency key ever seen,
forever, isn't realistic for a real system — the correctness guarantee only needs to
hold within a reasonable retry window, not forever.

**Why the window is anchored to first-seen, not last-seen:** if a duplicate check
refreshed an entry's expiry, a client that kept retrying the same key indefinitely
could keep that entry alive forever — defeating the entire point of a *bounded* window.

**Consequence, demonstrated not just asserted:** a retry arriving *after* the window
has closed is not recognized as a duplicate and is billed again. This is a real,
documented tradeoff, not a bug — see the late-duplicate scenario in
[`BENCHMARKS.md`](BENCHMARKS.md#late-duplicate-beyond-the-window). A bounded window
necessarily has an "outside the window" case by definition; the honest fix is to
choose a window wide enough for realistic retry behavior, not to pretend the case
doesn't exist.

**A useful side effect of the bound:** because every entry shares the same window
width, entries expire in *exactly* insertion order (insertion order == expiry order).
That lets eviction be a single FIFO queue popped from the front while expired — O(1)
amortized per operation, no full sweep, no background timer, no priority queue keyed
on individual expiry times. Confirmed empirically, not just by construction:
[`BENCHMARKS.md`](BENCHMARKS.md#3-dedup-store-lookup-latency-vs-window-size) shows
lookup latency staying flat across three orders of magnitude of window size.

## Payload-hash conflict detection

**Choice:** the dedup hash covers an event's *business fields* (`tenantId`, `metric`,
`quantity`, `occurredAtMs`) — deliberately **excluding** `idempotencyKey` itself.

**Why:** this is what lets the store distinguish two situations that otherwise look
identical from the key alone: "the same event, retried" (duplicate — safe to ignore)
versus "a different event that happens to reuse the same key" (a client bug — must be
surfaced, not silently absorbed as harmless). Silently treating the second case as a
duplicate would hide a real client-side bug; silently treating it as a fresh event
would double-count. `409 Conflict` is the answer that does neither.

## Composite dedup key via JSON encoding, not string concatenation

**Choice:** the dedup store's composite key is `JSON.stringify([tenantId,
idempotencyKey])`, not a delimiter-joined string like `` `${tenantId}:${key}` ``.

**Why:** a delimiter-joined string risks collision if either field can itself contain
the delimiter — tenant `"a:b"` + key `"c"` would collide with tenant `"a"` + key
`"b:c"`. JSON array encoding has no such ambiguity, since array elements are
individually length-delimited by the encoding itself.

## Synchronous, in-request aggregation

**Choice:** an accepted event is applied to the aggregator synchronously, in the same
request, before the `202` response is sent — not queued for later, periodic
materialization.

**Why:** at this stage of the system there is no competing concern (durability,
backpressure, multi-writer contention) that would motivate deferring aggregation.
Introducing async batching without such a concern to justify it would be speculative
complexity. The concrete payoff: the query API's answer is *always* fully up to date,
with zero aggregation lag by construction — measured directly in
[`BENCHMARKS.md`](BENCHMARKS.md#1-correctness-vs-duplicate-rate)'s throughput results
(`postLoadQueryLatencyMs` staying sub-millisecond-to-low-single-digit-ms at every
concurrency level).

**Tradeoff:** this couples ingestion latency to aggregation cost, and doesn't yet
account for durability or multi-writer scaling concerns a production system would
eventually need to address (see [Known Limitations](../README.md#known-limitations)).

## Rate limiting keyed on authenticated tenant, never client-supplied `tenantId`

**Choice:** the per-tenant token bucket is keyed by the tenant the API key resolved
to, not the `tenantId` field the client puts in the request body.

**Why:** the client-supplied `tenantId` isn't a trustworthy identity on its own — a
misbehaving client could claim a different tenant to dodge its own rate limit. Keying
the limiter on the *authenticated* identity is the correct principle regardless of the
fact that the separate tenant-mismatch check (`403`) means these two values would
always already agree for any request that reaches the rate limiter at all.

## Auth checked before body validation

**Choice:** the `x-api-key` check runs in a Fastify `preValidation` hook, which
executes *before* JSON-Schema body validation.

**Why:** an unauthenticated caller should learn nothing about whether its payload
would otherwise have been well-formed. Checking auth first means a `401` response
carries no information about the body's shape.

## Naive baseline is a fair comparison, not a strawman

**Choice:** `buildNaiveServer` uses the same route shape and the same schema
validation as `buildServer` — the only difference is it has no dedup store, so every
well-formed submission (including an exact resubmission) is accepted and applied.

**Why:** the correctness benchmark's whole point is to measure exactly what the dedup
layer buys. An artificially crippled comparison point (e.g. one that also skips schema
validation, or omits other unrelated functionality) would inflate the apparent benefit
of dedup with unrelated differences, making the comparison meaningless.

## Delay modeled via injectable clock, not real waiting

**Choice:** the adversarial test client injects duplicates and reordering, but does
**not** simulate network delay as a literal per-submission wall-clock wait.

**Why:** a network delay's actual *effect* on this system is "the server's receipt-time
clock has advanced further than it otherwise would have by the time this request
lands" — and `buildServer` already has a clean, deterministic lever for exactly that:
an injectable `clock` option, in place since the ingestion API's first version. The
correctness benchmark's late-duplicate scenario uses that lever directly (jumping the
fake clock forward) rather than teaching the test client to simulate real elapsed
time — keeping the whole correctness suite instant to run and fully deterministic,
with no real waiting anywhere in the test suite.

## Unbounded bucket growth vs. zero attribution loss

**Choice:** `SlidingWindowAggregator` never evicts a bucket, for any tenant, metric, or
time. Bucket-map memory grows without bound over a process's lifetime.

**Why accepted:** the alternative — evicting old buckets — would mean a very
late-arriving event for an old, already-evicted bucket has nowhere correct to land,
silently losing billing attribution. The tradeoff chosen here is unbounded memory
growth in exchange for **zero attribution loss regardless of how late an event
arrives**, demonstrated directly by a dedicated boundary test (one event recorded,
then 1,000 more spanning far into the future, with the original entry asserted still
exactly intact). Revisit only if unbounded growth becomes a measured, real memory
concern — nothing so far suggests it will at this project's scale.

## Domain type lives in `aggregator`, not `ingest`

**Choice:** `UsageEvent` (and its Fastify JSON Schema) live in `packages/aggregator`,
with `packages/ingest` depending on `aggregator` for it — not the other way around.

**Why:** `aggregator` is the core domain package; `ingest` is the transport/API layer
built on top of it. The domain event type belongs in the core, not in whichever layer
happened to define it first. The reverse dependency (`aggregator` importing from
`ingest`) would be architecturally backwards — domain logic depending on its own
transport layer.

## Known, confirmed gaps — not silent omissions

Two scope boundaries were raised as explicit questions rather than decided silently,
and are recorded here so they read as deliberate, not accidental:

- **No durable event log.** A process restart loses all in-memory dedup/aggregate
  state. A real deployment would need persistence to survive a mid-stream restart
  without losing or double-applying events; this project doesn't build that yet.
- **`GET /aggregates/:tenantId` is unauthenticated.** Any caller can currently query
  any tenant's totals. Auth was scoped specifically to the ingestion endpoint;
  read-side tenant isolation for the query API is a known, unbuilt gap.

Both are called out in the [README's Known Limitations](../README.md#known-limitations)
section as well — listed in both places so neither a code reader nor a docs reader
misses them.
