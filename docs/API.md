# API Reference

Base URL (local): `http://localhost:3000` (configurable — see [Configuration](#configuration)).

All request/response bodies are JSON. All endpoints are served by `packages/ingest`
(`buildServer` in [`packages/ingest/src/api/server.ts`](../packages/ingest/src/api/server.ts)).

## Authentication

`POST /events` requires an `x-api-key` header. There is no default/open mode — an
empty or missing key map means **every** request is rejected (fail closed), which is
the deliberate default for a misconfigured deployment.

The API key resolves to a tenant (`apiKeys: Record<apiKey, tenantId>`). The
**authenticated tenant must exactly match the `tenantId` field in the request body**,
or the request is rejected — this stops an authenticated caller from submitting events
*as* a different tenant, which would otherwise make per-tenant dedup/aggregation
isolation meaningless.

`GET /aggregates/:tenantId` and `GET /health` are **not** authenticated. This is a
known, deliberate gap — see [Known Limitations](../README.md#known-limitations).

## Endpoints

### `POST /events`

Submit a single usage event.

**Headers**

| Header | Required | Description |
|---|---|---|
| `content-type` | yes | `application/json` |
| `x-api-key` | yes | Resolves to the authenticated tenant. |

**Body**

```jsonc
{
  "tenantId": "tenant-a",       // string, required, non-empty
  "idempotencyKey": "evt-001",  // string, required, non-empty
  "metric": "api_calls",        // string, required, non-empty
  "quantity": 1,                 // number, required, > 0
  "occurredAtMs": 1732000000000  // integer, required, >= 0 — the CLIENT-ASSERTED
                                  // event time, not receipt time. This is the field
                                  // aggregation buckets on.
}
```

`additionalProperties: false` — an unknown field in the body is rejected as a `400`,
not silently dropped.

**Responses**

| Status | Body | Meaning |
|---|---|---|
| `202 Accepted` | `{"status":"accepted"}` | First time this `(tenantId, idempotencyKey)` has been seen within the dedup window. Applied to the running total synchronously, before this response is sent. |
| `200 OK` | `{"status":"duplicate"}` | Same key, same payload (business fields) as a prior event within the window — a legitimate retry. **Not** applied to the total again. |
| `409 Conflict` | `{"status":"rejected","reason":"idempotency_key_conflict"}` | Same key as a prior event, but a **different** payload — the caller reused an idempotency key for what is semantically a different event. Not applied to the total. |
| `400 Bad Request` | Fastify's standard JSON-Schema-validation error body | Body fails schema validation (missing field, wrong type, `quantity <= 0`, unknown field, etc.). The dedup store and aggregator are never touched. |
| `401 Unauthorized` | `{"status":"rejected","reason":"missing_api_key"}` or `{"status":"rejected","reason":"invalid_api_key"}` | `x-api-key` header missing, or not a recognized key. Checked **before** body validation — an unauthenticated caller learns nothing about whether its payload was otherwise well-formed. |
| `403 Forbidden` | `{"status":"rejected","reason":"tenant_mismatch"}` | The authenticated tenant (from the API key) does not match `tenantId` in the body. |
| `429 Too Many Requests` | `{"status":"rejected","reason":"rate_limited"}` | The authenticated tenant has exhausted its rate-limit token bucket. A `Retry-After` header (whole seconds) is included. Neither the dedup store nor the aggregator is touched. |

**Ordering of checks**, applied in this order for every request:
`auth (401)` → `body schema (400)` → `tenant match (403)` → `rate limit (429)` →
`dedup (200/202/409)`.

### `GET /aggregates/:tenantId`

Current running totals for a tenant. **Not authenticated** (see
[Known Limitations](../README.md#known-limitations)). Always reflects every accepted
event up to the moment of the request — aggregation is applied synchronously at
ingestion time, so there is no polling delay or eventual-consistency window.

**Query parameters**

| Param | Required | Description |
|---|---|---|
| `metric` | no | If given, the response is restricted to that one metric. If omitted, every metric the tenant has ever reported is returned. |

**Responses**

`200 OK`, always (an unknown tenant or metric returns a zero total, not a `404`):

```jsonc
// GET /aggregates/tenant-a
{ "tenantId": "tenant-a", "totals": { "api_calls": 42, "storage_gb": 2.5 } }

// GET /aggregates/tenant-a?metric=api_calls
{ "tenantId": "tenant-a", "totals": { "api_calls": 42 } }

// GET /aggregates/unknown-tenant
{ "tenantId": "unknown-tenant", "totals": {} }
```

### `GET /health`

Liveness check. Not authenticated.

`200 OK` → `{"status":"ok"}`

## Dedup semantics

The dedup key is `(tenantId, idempotencyKey)` — the same key on two different tenants
never collides. Whether a repeated key is a `duplicate` or a `conflict` depends on a
SHA-256 hash of the event's *business fields only* (`tenantId`, `metric`, `quantity`,
`occurredAtMs` — deliberately **excluding** `idempotencyKey` itself):

- Same key, same hash → **duplicate** (a legitimate retry).
- Same key, different hash → **conflict** (a client bug: this key was already used for
  a semantically different event).

The dedup window is **bounded and anchored to first-seen time**: checking a key again
(whether it turns out to be a duplicate or a conflict) does **not** extend its expiry.
A retry that arrives after the window has elapsed is treated as brand new — not
recognized as a duplicate, and billed again. This is a deliberate, documented tradeoff
(see [`DECISIONS.md`](DECISIONS.md#bounded-dedup-window)), demonstrated directly by the
correctness benchmark's late-duplicate scenario in
[`docs/BENCHMARKS.md`](BENCHMARKS.md#late-duplicate-beyond-the-window).

## Configuration

The `start.ts` entrypoint (`npm run start --workspace=packages/ingest`, or
`node dist/start.js` after a build) reads these environment variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port to listen on. |
| `HOST` | `0.0.0.0` | Interface to bind. |
| `DEDUP_WINDOW_MS` | `300000` (5 min) | Idempotency-key dedup window width. |
| `BUCKET_SIZE_MS` | `60000` (1 min) | Aggregation bucket width. |
| `RATE_LIMIT_RPS` | `50` | Sustained requests/sec allowed per tenant. |
| `RATE_LIMIT_BURST` | `100` | Token-bucket burst capacity per tenant. |
| `API_KEYS_JSON` | `{}` (fails closed — every request rejected) | JSON object mapping API key → tenant ID, e.g. `'{"sk_live_abc123":"tenant-a"}'`. |

`buildServer(options)` itself (for embedding or testing) requires all of
`dedupWindowMs`, `bucketSizeMs`, `apiKeys`, and `rateLimit` explicitly — there is no
optional-with-an-insecure-default for any of them, so no caller can accidentally end up
with auth or rate limiting silently disabled. See
[`packages/ingest/src/api/server.ts`](../packages/ingest/src/api/server.ts) for the
full `BuildServerOptions` type.

## Error-response shape

Every non-2xx response from the ingestion endpoint follows the same shape:

```jsonc
{ "status": "rejected", "reason": "<machine-readable reason code>" }
```

except `400` (Fastify's own JSON-Schema validation error, which has its own standard
shape) and `409` (which reuses the same `{status, reason}` shape with
`reason: "idempotency_key_conflict"`).
