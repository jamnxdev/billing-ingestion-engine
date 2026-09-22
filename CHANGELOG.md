# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project has not yet
reached a `1.0` release, so changes are grouped by build stage rather than by semantic
version.

## [Unreleased]

### Added

- API-key authentication (`x-api-key` header) on `POST /events`, scoped per tenant,
  fail-closed by default (no configured keys means every request is rejected).
- Per-tenant rate limiting (`TokenBucket`), keyed on the authenticated tenant, with a
  `Retry-After` header on `429` responses.
- Throughput benchmark (`packages/bench`), sweeping concurrency `1`–`100` over real
  HTTP, including post-load `GET /aggregates` latency as direct evidence of near-zero
  aggregation lag.
- Dedup-store lookup-latency-vs-window-size benchmark, confirming O(1)-amortized
  eviction holds across window sizes spanning three orders of magnitude.
- Full documentation suite: `docs/ARCHITECTURE.md`, `docs/API.md`,
  `docs/BENCHMARKS.md`, `docs/DECISIONS.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
  `SECURITY.md`, GitHub issue/PR templates, and CI.

### Changed

- `BuildServerOptions` now requires `apiKeys` and `rateLimit` explicitly — no
  optional-with-an-insecure-default for either, so no caller can end up with auth or
  rate limiting silently disabled.

## Adversarial test client, naive baseline, correctness benchmark

### Added

- `@billing/testclient` — deterministic, seeded ground-truth event generator
  (`generateGroundTruth`) and adversarial stream builder (`buildAdversarialStream`)
  modeling duplicate injection and reordering.
- `@billing/bench` — `CorrectnessBenchmark`, sweeping duplicate rates `{0%, 10%, 50%,
  90%}` against both the real (deduped) server and a naive (no-dedup) baseline,
  compared against offline-computed ground truth.
- `buildNaiveServer` (`packages/ingest`) — the "trust the client, no dedup" baseline
  used as the direct A/B comparison point for the correctness benchmark.
- Late-duplicate-beyond-window scenario, demonstrating the bounded dedup window's
  documented tradeoff directly.
- First committed benchmark results (`packages/bench/results/*.csv`, `.json`).

## Out-of-order/late-arrival handling, boundary-condition tests

### Added

- Property-based order-independence tests (`fast-check`): final totals and per-bucket
  breakdowns are identical regardless of submission order, verified over 200 randomized
  runs each, at both the aggregator level and the full HTTP-path level.
- Hand-picked boundary/out-of-order scenarios: reverse-chronological submission across
  a bucket boundary, a very-late single event arriving last, multi-tenant/multi-metric
  interleaving, and the explicit no-eviction/boundary-loss demonstration.

## Sliding-window aggregator, wired into ingestion

### Added

- `@billing/aggregator` — `SlidingWindowAggregator`: per-tenant, per-metric cumulative
  running totals bucketed by each event's own `occurredAtMs`.
- `GET /aggregates/:tenantId?metric=<name>` endpoint.
- Synchronous, in-request aggregation on every accepted (`"new"`) event.

### Changed

- `UsageEvent` (domain type + JSON Schema) moved from `packages/ingest` into the new
  `packages/aggregator`, with `ingest` depending on `aggregator` — not the reverse.

## Event schema, ingestion API, idempotency-key dedup logic and tests

### Added

- Initial npm-workspaces monorepo scaffolding (`packages/ingest`), TypeScript strict
  mode, Fastify-based HTTP layer.
- `UsageEvent` domain type and Fastify JSON Schema.
- `DedupStore` — bounded-window, per-tenant idempotency-key deduplication with
  payload-hash-based conflict detection (`new` / `duplicate` / `conflict`).
- `POST /events` and `GET /health` endpoints.
