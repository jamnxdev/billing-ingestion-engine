# Usage-Metering & Billing Ingestion Engine

[![CI](https://github.com/jamnxdev/billing-ingestion-engine/actions/workflows/ci.yml/badge.svg)](https://github.com/jamnxdev/billing-ingestion-engine/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](tsconfig.base.json)

An event-ingestion pipeline that turns a stream of API-usage events into accurate,
real-time billing totals — **correct even when events arrive duplicated, out of
order, or as retries**, and measurably more correct than the naive "trust the
client" alternative most billing pipelines start out as.

This exists to answer one concrete question with real numbers instead of
hand-waving: *how much does idempotent, order-independent ingestion actually
buy you over the naive approach, and what does it cost in throughput and
latency?* [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md) has the answer: at a 90%
duplicate rate, the naive design over-bills by ~89%; this design stays at
100% correctness across every tested duplicate rate, at ~7,000 req/s on a
single dev-machine process.

> **Project status:** actively built, day-by-day, as a portfolio project.
> Ingestion, deduplication, aggregation, adversarial testing, correctness/
> throughput benchmarking, per-tenant rate limiting, and API-key auth are
> built and tested (see [Status](#status)). Production deployment and a
> durable event log are **not** built yet — see [Known Limitations](#known-limitations).

---

## Table of contents

- [Why this exists](#why-this-exists)
- [Quickstart](#quickstart)
- [How it works](#how-it-works)
- [Project layout](#project-layout)
- [API reference](#api-reference)
- [Benchmarks](#benchmarks)
- [Known limitations](#known-limitations)
- [Status](#status)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [License](#license)

## Why this exists

Metered billing systems ingest usage events from clients (API calls, storage-GB-hours,
compute-seconds, etc.) and turn them into totals a customer gets charged for. Three
things make that harder than it sounds, and this project builds a small, tested system
around each one:

1. **Retries happen, and must not double-bill.** A client (or a proxy, or a flaky
   network) will resend the same event. An ingestion API that just accepts everything
   it receives will double-count every retry — see the naive baseline in
   [`packages/ingest/src/api/naiveServer.ts`](packages/ingest/src/api/naiveServer.ts) and
   the measured impact in [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md).
2. **Events don't arrive in the order they happened.** Network jitter, retries, and
   multi-region clients mean "arrival order" and "event order" are different things.
   Billing totals must be identical regardless of which order events happen to arrive in.
3. **A reused idempotency key with a *different* payload is a client bug, not a
   duplicate.** The system needs to tell those two cases apart and surface the second
   one rather than silently mis-billing.

The rest of this README, and the docs linked from it, show exactly how each of those is
handled — and tested.

## Quickstart

**Requirements:** Node.js ≥ 20, npm ≥ 10.

```bash
git clone https://github.com/jamnxdev/billing-ingestion-engine.git
cd billing-ingestion-engine
npm install
npm run build --workspaces
npm run test --workspaces
```

Run the ingestion API locally:

```bash
# API_KEYS_JSON maps API key -> tenantId. With none set, every request is
# rejected (fails closed) — see docs/API.md for full auth details.
API_KEYS_JSON='{"dev-key-1":"tenant-a"}' npm run start --workspace=packages/ingest
```

In another terminal:

```bash
# Submit a usage event
curl -i -X POST http://localhost:3000/events \
  -H 'content-type: application/json' \
  -H 'x-api-key: dev-key-1' \
  -d '{
    "tenantId": "tenant-a",
    "idempotencyKey": "evt-001",
    "metric": "api_calls",
    "quantity": 1,
    "occurredAtMs": 1732000000000
  }'
# -> 202 Accepted {"status":"accepted"}

# Resubmit the exact same event (a retry)
curl -i -X POST http://localhost:3000/events \
  -H 'content-type: application/json' \
  -H 'x-api-key: dev-key-1' \
  -d '{"tenantId":"tenant-a","idempotencyKey":"evt-001","metric":"api_calls","quantity":1,"occurredAtMs":1732000000000}'
# -> 200 OK {"status":"duplicate"}  (not double-counted)

# Read the tenant's running totals
curl http://localhost:3000/aggregates/tenant-a
# -> {"tenantId":"tenant-a","totals":{"api_calls":1}}
```

Run the full correctness benchmark (the numbers behind the claim above):

```bash
npm run build --workspaces
npm run correctness --workspace=packages/bench
```

Full command reference for every package is in [Project layout](#project-layout).

## How it works

```
                        ┌──────────────────────────────────────────────┐
                        │                packages/ingest                │
                        │                                                │
  POST /events  ──────▶ │ auth (x-api-key) ─▶ rate limit (per tenant)    │
                        │      │                                         │
                        │      ▼                                         │
                        │ schema validation (Fastify JSON Schema)        │
                        │      │                                         │
                        │      ▼                                         │
                        │ DedupStore.check(tenantId, idempotencyKey, hash)│
                        │      │           │              │              │
                        │    "new"     "duplicate"    "conflict"         │
                        │      │           │              │              │
                        │      ▼           ▼              ▼              │
                        │ aggregator   200 OK         409 Conflict       │
                        │  .record()  (no-op, safe)  (client bug signal) │
                        │      │                                         │
                        │      ▼                                         │
                        │  202 Accepted                                  │
                        └──────────────────────────────────────────────┘
                                       │
                                       ▼
                        ┌──────────────────────────────────────────────┐
                        │              packages/aggregator               │
                        │  SlidingWindowAggregator: per-tenant, per-metric│
                        │  cumulative totals, bucketed by the event's own │
                        │  occurredAtMs (never by arrival time)           │
                        └──────────────────────────────────────────────┘
                                       ▲
                                       │
  GET /aggregates/:tenantId  ─────────┘   (always fully up to date — every
                                            accepted event is applied
                                            synchronously, zero aggregation lag)
```

Three design decisions make this work, each covered by dedicated tests:

- **Idempotency-key dedup is payload-aware.** The dedup store hashes an event's business
  fields (excluding the key itself) so it can tell "the same event retried" apart from
  "a different event reusing the same key" — the first is silently absorbed, the second
  is rejected with `409`. See [`packages/ingest/src/dedup/DedupStore.ts`](packages/ingest/src/dedup/DedupStore.ts).
- **Aggregation buckets by event time, never by arrival time.** Every event lands in the
  bucket its own `occurredAtMs` puts it in, so the final total is identical no matter
  what order events arrive in — proven with property-based tests over randomized event
  sets and shuffles, not just hand-picked examples. See
  [`packages/aggregator/src/SlidingWindowAggregator.ts`](packages/aggregator/src/SlidingWindowAggregator.ts).
- **The dedup window is bounded and anchored to first-seen time.** Unbounded retry
  storage isn't realistic, and refreshing an entry's expiry on every retry would let a
  client keep an entry alive forever — so the window is fixed-size and a retry never
  extends it. The tradeoff (a retry arriving *after* the window closes is billed again)
  is deliberate and demonstrated directly in the correctness benchmark's late-duplicate
  scenario.

Full narrative walkthrough, including every explicit design tradeoff and the "why," is
in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/DECISIONS.md`](docs/DECISIONS.md).

## Project layout

An npm workspaces monorepo, four packages, each independently buildable/testable:

| Package | Purpose | Depends on |
|---|---|---|
| [`packages/aggregator`](packages/aggregator) | Core domain: `UsageEvent` type + Fastify schema, `SlidingWindowAggregator` (bucketed, cumulative, per-tenant/per-metric totals). Zero HTTP dependency. | — |
| [`packages/ingest`](packages/ingest) | HTTP ingestion API (Fastify): auth, per-tenant rate limiting, idempotency-key dedup, wiring into the aggregator. Also hosts the naive (no-dedup) baseline server used for comparison. | `aggregator` |
| [`packages/testclient`](packages/testclient) | Deterministic, seeded ground-truth event generator and adversarial stream builder (duplicate injection, reordering) used to drive both the correct and naive servers under identical, reproducible load. | `aggregator` |
| [`packages/bench`](packages/bench) | Correctness benchmark (accuracy vs. duplicate rate), throughput benchmark (req/s and latency percentiles vs. concurrency), and dedup-store lookup-latency-vs-window-size benchmark. | `aggregator`, `ingest`, `testclient` |

Each package has its own `package.json` with `build`/`test` scripts; the root
`package.json` fans them out across all workspaces:

```bash
npm run build --workspaces          # tsc -b each package, in dependency order
npm run test --workspaces           # vitest run in each package
npm run test --workspace=packages/ingest   # a single package
```

`tsconfig.base.json` at the repo root (ES2022 target, `NodeNext` ESM, `strict: true`,
`noUncheckedIndexedAccess: true`) is extended by every package rather than duplicated.

## API reference

Full request/response contract, every status code, and every environment variable are
documented in [`docs/API.md`](docs/API.md). Summary:

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /events` | `x-api-key` header (required) | Submit a usage event. Returns `202` (accepted), `200` (duplicate, safely ignored), `409` (idempotency-key conflict), `400` (invalid body), `401`/`403` (auth), or `429` (rate limited). |
| `GET /aggregates/:tenantId?metric=<name>` | none *(known gap — see [Known Limitations](#known-limitations))* | Current running totals for a tenant, optionally filtered to one metric. |
| `GET /health` | none | Liveness check. |

## Benchmarks

Full methodology, raw commands, and every result table live in
[`docs/BENCHMARKS.md`](docs/BENCHMARKS.md), backed by the CSVs committed under
[`packages/bench/results/`](packages/bench/results/). Headline numbers, first-run on a
single dev machine (not yet repeated across independent runs or a dedicated benchmark
host — see the caveats in that doc):

- **Correctness vs. duplicate rate** — this design holds **100% exact-match correctness**
  at 0%, 10%, 50%, and 90% duplicate rates; the naive (no-dedup) baseline drops to **0%**
  the moment any duplicates exist, over-billing by up to **~89%** at a 90% duplicate rate.
- **Throughput** — plateaus around **~7,000 req/s** (single process, single dev machine)
  as concurrency rises from 1 to 100, with p50 latency under 13ms even at concurrency 100.
- **Aggregation lag** — sub-millisecond to low-single-digit-ms `GET /aggregates` latency
  measured immediately after load stops, the direct evidence that synchronous in-request
  aggregation carries effectively zero materialization delay.
- **Dedup lookup latency vs. window size** — p50/p95 stay flat (sub-2μs) across window
  sizes spanning three orders of magnitude (1s to 1hr) at fixed occupancy, confirming
  lookup cost is governed by entry count, not window size, as the O(1)-amortized-eviction
  design claims.

Reproduce the correctness table from a clean checkout:

```bash
npm install && npm run build --workspaces
./packages/bench/run-correctness-suite.sh
```

## Known limitations

Explicitly flagged, not silent gaps:

- **No durable event log.** All state (dedup entries, aggregate totals) is in-process
  memory. A process restart loses everything ingested since the last start — there is no
  recovery, no replay, no persistence layer yet.
- **`GET /aggregates/:tenantId` is unauthenticated.** Any caller can currently query any
  tenant's totals. Auth (Day 5's scope) was deliberately limited to the ingestion
  endpoint per the project's own security requirements; read-side tenant isolation is a
  known, unbuilt gap.
- **The dedup window is bounded, by design.** A retry that arrives *after* the
  configured window has elapsed is not recognized as a duplicate and is billed again.
  This is a deliberate, documented tradeoff (unbounded dedup storage isn't realistic),
  not a bug — see [`docs/DECISIONS.md`](docs/DECISIONS.md).
- **Aggregate buckets are never evicted.** Per-tenant/per-metric bucket maps grow
  without bound over a process's lifetime. Traded deliberately for zero attribution
  loss regardless of how late an event arrives — see [`docs/DECISIONS.md`](docs/DECISIONS.md).
- **Not yet deployed anywhere.** Everything above has been run and benchmarked locally
  only; there's no hosted instance and no deployment automation yet.

See [`docs/DECISIONS.md`](docs/DECISIONS.md) for the full reasoning behind each of these,
not just the list.

## Status

Built incrementally; each stage is a separate, reviewable commit:

- [x] Event schema, ingestion API, idempotency-key dedup
- [x] Sliding-window aggregator, wired into ingestion
- [x] Out-of-order/late-arrival handling, boundary-condition & property-based tests
- [x] Adversarial test client, naive baseline, correctness benchmark
- [x] API-key auth, per-tenant rate limiting, throughput & dedup-latency benchmarks
- [ ] Deployment, benchmarks re-run in a deployed environment
- [ ] Durable event log

97 automated tests pass across all four packages (`npm run test --workspaces`); every
package builds clean under `tsc --strict` with `noUncheckedIndexedAccess`. See individual
package `test/` directories for coverage detail, and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
for what each test suite actually proves.

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system design, data flow, and how each
  component fits together.
- [`docs/API.md`](docs/API.md) — full HTTP API reference: every endpoint, status code,
  and environment variable.
- [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md) — benchmark methodology and full results.
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — design decisions, tradeoffs, and deviations
  from the original plan, with the reasoning behind each.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — how to set up, test, and propose changes.
- [`SECURITY.md`](SECURITY.md) — supported scope and how to report a vulnerability.
- [`CHANGELOG.md`](CHANGELOG.md) — notable changes, in reverse-chronological order.

## Contributing

Contributions, issues, and questions are welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md)
for the development workflow, coding conventions, and how to submit a change. Please also
read the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE) © Jaimin Chovatia
