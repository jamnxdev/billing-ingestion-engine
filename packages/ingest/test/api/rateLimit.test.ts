import { describe, expect, it } from "vitest";
import { buildServer } from "../../src/api/server.js";
import type { UsageEvent } from "@billing/aggregator";
import { TEST_API_KEYS, postEvent } from "../testHelpers.js";

const BUCKET_MS = 60_000;

function event(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    tenantId: "tenant-a",
    idempotencyKey: "key-1",
    metric: "api_calls",
    quantity: 1,
    occurredAtMs: 0,
    ...overrides,
  };
}

describe("POST /events — per-tenant rate limiting", () => {
  it("allows up to burstCapacity requests immediately, then rejects the next one with 429", async () => {
    const app = buildServer({
      dedupWindowMs: 1000,
      bucketSizeMs: BUCKET_MS,
      apiKeys: TEST_API_KEYS,
      rateLimit: { requestsPerSecond: 1, burstCapacity: 3 },
      clock: () => 0, // frozen clock — no refill between requests in this test
    });

    for (let i = 0; i < 3; i++) {
      const res = await postEvent(app, event({ idempotencyKey: `k${i}` }));
      expect(res.statusCode).toBe(202);
    }

    const rejected = await postEvent(app, event({ idempotencyKey: "k-over-limit" }));
    expect(rejected.statusCode).toBe(429);
    expect(rejected.json()).toEqual({ status: "rejected", reason: "rate_limited" });
  });

  it("sets a Retry-After header (in whole seconds) when rate-limited", async () => {
    const app = buildServer({
      dedupWindowMs: 1000,
      bucketSizeMs: BUCKET_MS,
      apiKeys: TEST_API_KEYS,
      rateLimit: { requestsPerSecond: 2, burstCapacity: 1 },
      clock: () => 0,
    });

    await postEvent(app, event({ idempotencyKey: "k0" })); // consumes the only token
    const rejected = await postEvent(app, event({ idempotencyKey: "k1" }));
    expect(rejected.statusCode).toBe(429);
    expect(rejected.headers["retry-after"]).toBeDefined();
    expect(Number(rejected.headers["retry-after"])).toBeGreaterThanOrEqual(1);
  });

  it("a rate-limited request is never applied to dedup or the aggregate", async () => {
    const app = buildServer({
      dedupWindowMs: 1000,
      bucketSizeMs: BUCKET_MS,
      apiKeys: TEST_API_KEYS,
      rateLimit: { requestsPerSecond: 1, burstCapacity: 1 },
      clock: () => 0,
    });

    await postEvent(app, event({ idempotencyKey: "k0", quantity: 10 })); // consumes the token
    const rejected = await postEvent(app, event({ idempotencyKey: "k1", quantity: 999 }));
    expect(rejected.statusCode).toBe(429);

    const res = await app.inject({ method: "GET", url: "/aggregates/tenant-a?metric=api_calls" });
    expect(res.json()).toEqual({ tenantId: "tenant-a", totals: { api_calls: 10 } }); // not 1009
  });

  it("recovers and accepts requests again once tokens refill", async () => {
    let now = 0;
    const app = buildServer({
      dedupWindowMs: 1000,
      bucketSizeMs: BUCKET_MS,
      apiKeys: TEST_API_KEYS,
      rateLimit: { requestsPerSecond: 10, burstCapacity: 1 },
      clock: () => now,
    });

    await postEvent(app, event({ idempotencyKey: "k0" }));
    expect((await postEvent(app, event({ idempotencyKey: "k1" }))).statusCode).toBe(429);

    now = 200; // 200ms at 10 tokens/sec = 2 tokens refilled (capped at burstCapacity 1)
    const res = await postEvent(app, event({ idempotencyKey: "k2" }));
    expect(res.statusCode).toBe(202);
  });

  it("rate-limits tenants completely independently — one tenant's exhausted bucket does not affect another", async () => {
    const app = buildServer({
      dedupWindowMs: 1000,
      bucketSizeMs: BUCKET_MS,
      apiKeys: TEST_API_KEYS,
      rateLimit: { requestsPerSecond: 1, burstCapacity: 1 },
      clock: () => 0,
    });

    await postEvent(app, event({ tenantId: "tenant-a", idempotencyKey: "k0" }));
    expect((await postEvent(app, event({ tenantId: "tenant-a", idempotencyKey: "k1" }))).statusCode).toBe(429);

    // tenant-b has its own, untouched bucket.
    const res = await postEvent(app, event({ tenantId: "tenant-b", idempotencyKey: "k0" }));
    expect(res.statusCode).toBe(202);
  });
});
