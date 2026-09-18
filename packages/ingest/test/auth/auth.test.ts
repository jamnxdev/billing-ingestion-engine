import { describe, expect, it } from "vitest";
import { buildServer } from "../../src/api/server.js";
import type { UsageEvent } from "@billing/aggregator";
import { TEST_API_KEYS, GENEROUS_RATE_LIMIT, postEvent } from "../testHelpers.js";

const BUCKET_MS = 60_000;

function testServer() {
  return buildServer({
    dedupWindowMs: 1000,
    bucketSizeMs: BUCKET_MS,
    apiKeys: TEST_API_KEYS,
    rateLimit: GENEROUS_RATE_LIMIT,
  });
}

function validEvent(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    tenantId: "tenant-a",
    idempotencyKey: "key-1",
    metric: "api_calls",
    quantity: 1,
    occurredAtMs: 0,
    ...overrides,
  };
}

describe("POST /events — API-key authentication", () => {
  it("rejects a request with no x-api-key header with 401 missing_api_key", async () => {
    const app = testServer();
    const res = await postEvent(app, validEvent(), null);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ status: "rejected", reason: "missing_api_key" });
  });

  it("rejects a request with an unrecognized x-api-key with 401 invalid_api_key", async () => {
    const app = testServer();
    const res = await postEvent(app, validEvent(), "not-a-real-key");
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ status: "rejected", reason: "invalid_api_key" });
  });

  it("rejects a request whose body tenantId does not match the authenticated tenant with 403 tenant_mismatch", async () => {
    const app = testServer();
    // Valid key for tenant-a, but the body claims to be tenant-b.
    const res = await postEvent(app, validEvent({ tenantId: "tenant-b" }), "key-tenant-a");
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ status: "rejected", reason: "tenant_mismatch" });
  });

  it("accepts a request whose API key and body tenantId agree", async () => {
    const app = testServer();
    const res = await postEvent(app, validEvent({ tenantId: "tenant-a" }), "key-tenant-a");
    expect(res.statusCode).toBe(202);
  });

  it("rejects an unauthenticated request with 401 even when its body is otherwise malformed — auth runs before schema validation", async () => {
    const app = testServer();
    const malformed = { tenantId: "tenant-a" }; // missing every other required field
    const res = await postEvent(app, malformed as UsageEvent, null);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ status: "rejected", reason: "missing_api_key" });
  });

  it("never touches the dedup store or aggregator for a request that fails authentication", async () => {
    const app = testServer();
    await postEvent(app, validEvent({ quantity: 999 }), null); // rejected, 401

    // If this had somehow been applied, the total would be 999. It must still be 0.
    const res = await app.inject({ method: "GET", url: "/aggregates/tenant-a?metric=api_calls" });
    expect(res.json()).toEqual({ tenantId: "tenant-a", totals: { api_calls: 0 } });
  });

  it("does not require authentication for GET /aggregates (a known, flagged scope boundary — see the implementation log)", async () => {
    const app = testServer();
    const res = await app.inject({ method: "GET", url: "/aggregates/tenant-a" });
    expect(res.statusCode).toBe(200);
  });
});
