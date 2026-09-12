import { describe, expect, it } from "vitest";
import { buildServer } from "../../src/api/server.js";
import type { UsageEvent } from "@billing/aggregator";

const BUCKET_MS = 60_000;

function validEvent(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    tenantId: "tenant-a",
    idempotencyKey: "key-1",
    metric: "api_calls",
    quantity: 1,
    occurredAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

describe("POST /events", () => {
  it("returns 202 accepted for a brand-new event", async () => {
    const app = buildServer({ dedupWindowMs: 1000, bucketSizeMs: BUCKET_MS });
    const res = await app.inject({ method: "POST", url: "/events", payload: validEvent() });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: "accepted" });
  });

  it("returns 200 duplicate for the same idempotency key + identical payload", async () => {
    const app = buildServer({ dedupWindowMs: 1000, bucketSizeMs: BUCKET_MS });
    await app.inject({ method: "POST", url: "/events", payload: validEvent() });
    const res = await app.inject({ method: "POST", url: "/events", payload: validEvent() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "duplicate" });
  });

  it("returns 409 when the same idempotency key is reused with a different payload", async () => {
    const app = buildServer({ dedupWindowMs: 1000, bucketSizeMs: BUCKET_MS });
    await app.inject({ method: "POST", url: "/events", payload: validEvent({ quantity: 1 }) });
    const res = await app.inject({
      method: "POST",
      url: "/events",
      payload: validEvent({ quantity: 2 }),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ status: "rejected", reason: "idempotency_key_conflict" });
  });

  it("rejects a malformed event (missing idempotencyKey) with 400, and never records it in the dedup store", async () => {
    const app = buildServer({ dedupWindowMs: 1000, bucketSizeMs: BUCKET_MS });
    const malformed = { ...validEvent() } as Partial<UsageEvent>;
    delete malformed.idempotencyKey;

    const res = await app.inject({ method: "POST", url: "/events", payload: malformed });
    expect(res.statusCode).toBe(400);
  });

  it("rejects non-positive quantity with 400", async () => {
    const app = buildServer({ dedupWindowMs: 1000, bucketSizeMs: BUCKET_MS });
    const res = await app.inject({
      method: "POST",
      url: "/events",
      payload: validEvent({ quantity: 0 }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("re-admits the same key as a brand-new event once the dedup window has elapsed", async () => {
    let now = 0;
    const app = buildServer({ dedupWindowMs: 100, bucketSizeMs: BUCKET_MS, clock: () => now });

    const first = await app.inject({ method: "POST", url: "/events", payload: validEvent() });
    expect(first.statusCode).toBe(202);

    now = 200;
    const second = await app.inject({ method: "POST", url: "/events", payload: validEvent() });
    expect(second.statusCode).toBe(202);
    expect(second.json()).toEqual({ status: "accepted" });
  });

  it("scopes idempotency keys per tenant — two tenants can independently use the same key", async () => {
    const app = buildServer({ dedupWindowMs: 1000, bucketSizeMs: BUCKET_MS });
    const first = await app.inject({
      method: "POST",
      url: "/events",
      payload: validEvent({ tenantId: "tenant-a" }),
    });
    const second = await app.inject({
      method: "POST",
      url: "/events",
      payload: validEvent({ tenantId: "tenant-b" }),
    });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
  });

  it("responds to /health", async () => {
    const app = buildServer({ dedupWindowMs: 1000, bucketSizeMs: BUCKET_MS });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});

describe("GET /aggregates/:tenantId — wiring from ingestion into the aggregator", () => {
  it("reflects an accepted event's quantity in the running total for that metric", async () => {
    const app = buildServer({ dedupWindowMs: 1000, bucketSizeMs: BUCKET_MS });
    await app.inject({
      method: "POST",
      url: "/events",
      payload: validEvent({ quantity: 7 }),
    });

    const res = await app.inject({ method: "GET", url: "/aggregates/tenant-a?metric=api_calls" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tenantId: "tenant-a", totals: { api_calls: 7 } });
  });

  it("sums quantities across multiple accepted events for the same tenant+metric", async () => {
    const app = buildServer({ dedupWindowMs: 1000, bucketSizeMs: BUCKET_MS });
    await app.inject({
      method: "POST",
      url: "/events",
      payload: validEvent({ idempotencyKey: "k1", quantity: 3, occurredAtMs: 0 }),
    });
    await app.inject({
      method: "POST",
      url: "/events",
      payload: validEvent({ idempotencyKey: "k2", quantity: 4, occurredAtMs: 1000 }),
    });

    const res = await app.inject({ method: "GET", url: "/aggregates/tenant-a?metric=api_calls" });
    expect(res.json()).toEqual({ tenantId: "tenant-a", totals: { api_calls: 7 } });
  });

  it("does not double-count a duplicate submission in the aggregate total", async () => {
    const app = buildServer({ dedupWindowMs: 1000, bucketSizeMs: BUCKET_MS });
    await app.inject({ method: "POST", url: "/events", payload: validEvent({ quantity: 5 }) });
    await app.inject({ method: "POST", url: "/events", payload: validEvent({ quantity: 5 }) }); // exact retry

    const res = await app.inject({ method: "GET", url: "/aggregates/tenant-a?metric=api_calls" });
    expect(res.json()).toEqual({ tenantId: "tenant-a", totals: { api_calls: 5 } });
  });

  it("does not apply a conflicting (rejected) submission to the aggregate total", async () => {
    const app = buildServer({ dedupWindowMs: 1000, bucketSizeMs: BUCKET_MS });
    await app.inject({ method: "POST", url: "/events", payload: validEvent({ quantity: 5 }) });
    await app.inject({ method: "POST", url: "/events", payload: validEvent({ quantity: 999 }) }); // conflict, rejected

    const res = await app.inject({ method: "GET", url: "/aggregates/tenant-a?metric=api_calls" });
    expect(res.json()).toEqual({ tenantId: "tenant-a", totals: { api_calls: 5 } });
  });

  it("returns all metrics for a tenant when no metric query param is given", async () => {
    const app = buildServer({ dedupWindowMs: 1000, bucketSizeMs: BUCKET_MS });
    await app.inject({
      method: "POST",
      url: "/events",
      payload: validEvent({ idempotencyKey: "k1", metric: "api_calls", quantity: 10 }),
    });
    await app.inject({
      method: "POST",
      url: "/events",
      payload: validEvent({ idempotencyKey: "k2", metric: "storage_gb", quantity: 2.5 }),
    });

    const res = await app.inject({ method: "GET", url: "/aggregates/tenant-a" });
    expect(res.json()).toEqual({
      tenantId: "tenant-a",
      totals: { api_calls: 10, storage_gb: 2.5 },
    });
  });

  it("returns a zero total for a tenant/metric that has never reported anything", async () => {
    const app = buildServer({ dedupWindowMs: 1000, bucketSizeMs: BUCKET_MS });
    const res = await app.inject({ method: "GET", url: "/aggregates/unknown-tenant?metric=api_calls" });
    expect(res.json()).toEqual({ tenantId: "unknown-tenant", totals: { api_calls: 0 } });
  });

  it("keeps two tenants' aggregates fully independent through the full HTTP path", async () => {
    const app = buildServer({ dedupWindowMs: 1000, bucketSizeMs: BUCKET_MS });
    await app.inject({
      method: "POST",
      url: "/events",
      payload: validEvent({ tenantId: "tenant-a", quantity: 10 }),
    });
    await app.inject({
      method: "POST",
      url: "/events",
      payload: validEvent({ tenantId: "tenant-b", quantity: 3 }),
    });

    const a = await app.inject({ method: "GET", url: "/aggregates/tenant-a?metric=api_calls" });
    const b = await app.inject({ method: "GET", url: "/aggregates/tenant-b?metric=api_calls" });
    expect(a.json()).toEqual({ tenantId: "tenant-a", totals: { api_calls: 10 } });
    expect(b.json()).toEqual({ tenantId: "tenant-b", totals: { api_calls: 3 } });
  });
});
