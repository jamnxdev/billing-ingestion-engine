import { describe, expect, it } from "vitest";
import { payloadHash } from "../../src/dedup/payloadHash.js";
import type { UsageEvent } from "@billing/aggregator";

function event(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    tenantId: "tenant-a",
    idempotencyKey: "key-1",
    metric: "api_calls",
    quantity: 1,
    occurredAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

describe("payloadHash", () => {
  it("is identical for two structurally identical events", () => {
    expect(payloadHash(event())).toBe(payloadHash(event()));
  });

  it("is unaffected by a different idempotencyKey (hash is over business fields only)", () => {
    expect(payloadHash(event({ idempotencyKey: "key-1" }))).toBe(
      payloadHash(event({ idempotencyKey: "key-2" })),
    );
  });

  it("differs when quantity differs", () => {
    expect(payloadHash(event({ quantity: 1 }))).not.toBe(payloadHash(event({ quantity: 2 })));
  });

  it("differs when metric differs", () => {
    expect(payloadHash(event({ metric: "api_calls" }))).not.toBe(
      payloadHash(event({ metric: "storage_gb" })),
    );
  });

  it("differs when occurredAtMs differs", () => {
    expect(payloadHash(event({ occurredAtMs: 1 }))).not.toBe(
      payloadHash(event({ occurredAtMs: 2 })),
    );
  });

  it("differs when tenantId differs", () => {
    expect(payloadHash(event({ tenantId: "tenant-a" }))).not.toBe(
      payloadHash(event({ tenantId: "tenant-b" })),
    );
  });
});
