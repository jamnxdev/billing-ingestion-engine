# Usage-Metering & Billing Ingestion Engine

An event-ingestion pipeline that turns a stream of API-usage events into
accurate, real-time billing aggregates — correct even when events arrive
duplicated, out of order, or during retries.

Status: **in progress** (Day 1 of the 7-day build plan). See
`packages/ingest` for the ingestion API.

## Packages

- `packages/ingest` — HTTP ingestion API, idempotency-key deduplication.
  (Aggregation, the adversarial test client, and benchmarks are added in
  later days and will get their own packages/READMEs.)

## Development

```bash
npm install
npm run build --workspaces
npm run test --workspaces
```
