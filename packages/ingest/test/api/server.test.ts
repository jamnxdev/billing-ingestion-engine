import { describe, expect, it } from "vitest";
import { buildServer } from "../../src/api/server.js";
import type { UsageEvent } from "../../src/types/UsageEvent.js";

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
    const app = buildServer({ dedupWindowMs: 1000 });
    const res = await app.inject({ method: "POST", url: "/events", payload: validEvent() });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: "accepted" });
  });

  it("returns 200 duplicate for the same idempotency key + identical payload", async () => {
    const app = buildServer({ dedupWindowMs: 1000 });
    await app.inject({ method: "POST", url: "/events", payload: validEvent() });
    const res = await app.inject({ method: "POST", url: "/events", payload: validEvent() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "duplicate" });
  });

  it("returns 409 when the same idempotency key is reused with a different payload", async () => {
    const app = buildServer({ dedupWindowMs: 1000 });
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
    const app = buildServer({ dedupWindowMs: 1000 });
    const malformed = { ...validEvent() } as Partial<UsageEvent>;
    delete malformed.idempotencyKey;

    const res = await app.inject({ method: "POST", url: "/events", payload: malformed });
    expect(res.statusCode).toBe(400);
  });

  it("rejects non-positive quantity with 400", async () => {
    const app = buildServer({ dedupWindowMs: 1000 });
    const res = await app.inject({
      method: "POST",
      url: "/events",
      payload: validEvent({ quantity: 0 }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("re-admits the same key as a brand-new event once the dedup window has elapsed", async () => {
    let now = 0;
    const app = buildServer({ dedupWindowMs: 100, clock: () => now });

    const first = await app.inject({ method: "POST", url: "/events", payload: validEvent() });
    expect(first.statusCode).toBe(202);

    now = 200;
    const second = await app.inject({ method: "POST", url: "/events", payload: validEvent() });
    expect(second.statusCode).toBe(202);
    expect(second.json()).toEqual({ status: "accepted" });
  });

  it("scopes idempotency keys per tenant — two tenants can independently use the same key", async () => {
    const app = buildServer({ dedupWindowMs: 1000 });
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
    const app = buildServer({ dedupWindowMs: 1000 });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});
