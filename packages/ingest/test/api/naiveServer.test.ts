import { describe, expect, it } from "vitest";
import { buildNaiveServer } from "../../src/api/naiveServer.js";
import type { UsageEvent } from "@billing/aggregator";

const BUCKET_MS = 60_000;

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

describe("buildNaiveServer — the 'trust the client, no dedup' baseline", () => {
  it("accepts a well-formed event and applies it to the aggregate", async () => {
    const app = buildNaiveServer({ bucketSizeMs: BUCKET_MS });
    const res = await app.inject({ method: "POST", url: "/events", payload: validEvent({ quantity: 5 }) });
    expect(res.statusCode).toBe(202);

    const agg = await app.inject({ method: "GET", url: "/aggregates/tenant-a?metric=api_calls" });
    expect(agg.json()).toEqual({ tenantId: "tenant-a", totals: { api_calls: 5 } });
  });

  it("has no idempotency awareness at all — an exact resubmission is double-counted", async () => {
    const app = buildNaiveServer({ bucketSizeMs: BUCKET_MS });
    await app.inject({ method: "POST", url: "/events", payload: validEvent({ quantity: 5 }) });
    await app.inject({ method: "POST", url: "/events", payload: validEvent({ quantity: 5 }) }); // identical resubmission

    const agg = await app.inject({ method: "GET", url: "/aggregates/tenant-a?metric=api_calls" });
    expect(agg.json()).toEqual({ tenantId: "tenant-a", totals: { api_calls: 10 } }); // double-counted, unlike buildServer
  });

  it("still rejects a malformed body with 400 (schema validation is not the thing being removed)", async () => {
    const app = buildNaiveServer({ bucketSizeMs: BUCKET_MS });
    const malformed = { ...validEvent() } as Partial<UsageEvent>;
    delete malformed.quantity;
    const res = await app.inject({ method: "POST", url: "/events", payload: malformed });
    expect(res.statusCode).toBe(400);
  });
});
