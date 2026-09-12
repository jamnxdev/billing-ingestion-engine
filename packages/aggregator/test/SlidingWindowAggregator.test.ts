import { describe, expect, it } from "vitest";
import { SlidingWindowAggregator } from "../src/SlidingWindowAggregator.js";
import type { UsageEvent } from "../src/types/UsageEvent.js";

const BUCKET_MS = 60_000; // 1-minute buckets

function event(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    tenantId: "tenant-a",
    idempotencyKey: "irrelevant-here",
    metric: "api_calls",
    quantity: 1,
    occurredAtMs: 0,
    ...overrides,
  };
}

describe("SlidingWindowAggregator", () => {
  it("rejects a non-positive bucket size", () => {
    expect(() => new SlidingWindowAggregator({ bucketSizeMs: 0 })).toThrow();
    expect(() => new SlidingWindowAggregator({ bucketSizeMs: -1 })).toThrow();
  });

  it("returns 0 for a tenant/metric that has never reported anything", () => {
    const agg = new SlidingWindowAggregator({ bucketSizeMs: BUCKET_MS });
    expect(agg.totalFor("unknown-tenant", "unknown-metric")).toBe(0);
    expect(agg.totalsForTenant("unknown-tenant")).toEqual({});
  });

  it("records a single event and reflects it in the total", () => {
    const agg = new SlidingWindowAggregator({ bucketSizeMs: BUCKET_MS });
    agg.record(event({ quantity: 5, occurredAtMs: 1000 }));
    expect(agg.totalFor("tenant-a", "api_calls")).toBe(5);
  });

  it("sums multiple events for the same tenant+metric within one bucket", () => {
    const agg = new SlidingWindowAggregator({ bucketSizeMs: BUCKET_MS });
    agg.record(event({ quantity: 3, occurredAtMs: 1000 }));
    agg.record(event({ quantity: 4, occurredAtMs: 2000 }));
    agg.record(event({ quantity: 2, occurredAtMs: 59_999 }));
    expect(agg.totalFor("tenant-a", "api_calls")).toBe(9);
    expect(agg.bucketsFor("tenant-a", "api_calls")).toEqual(new Map([[0, 9]]));
  });

  it("sums events across multiple buckets into one running total", () => {
    const agg = new SlidingWindowAggregator({ bucketSizeMs: BUCKET_MS });
    agg.record(event({ quantity: 3, occurredAtMs: 0 })); // bucket 0
    agg.record(event({ quantity: 4, occurredAtMs: BUCKET_MS })); // bucket 60_000
    agg.record(event({ quantity: 5, occurredAtMs: BUCKET_MS * 10 })); // bucket 600_000
    expect(agg.totalFor("tenant-a", "api_calls")).toBe(12);
    expect(agg.bucketsFor("tenant-a", "api_calls")).toEqual(
      new Map([
        [0, 3],
        [BUCKET_MS, 4],
        [BUCKET_MS * 10, 5],
      ]),
    );
  });

  it("attributes an event to the correct bucket exactly at a boundary (bucket start is inclusive)", () => {
    const agg = new SlidingWindowAggregator({ bucketSizeMs: BUCKET_MS });
    agg.record(event({ quantity: 1, occurredAtMs: BUCKET_MS })); // exactly on the boundary
    expect(agg.bucketsFor("tenant-a", "api_calls")).toEqual(new Map([[BUCKET_MS, 1]]));
  });

  it("keeps totals for different metrics of the same tenant independent", () => {
    const agg = new SlidingWindowAggregator({ bucketSizeMs: BUCKET_MS });
    agg.record(event({ metric: "api_calls", quantity: 10, occurredAtMs: 0 }));
    agg.record(event({ metric: "storage_gb", quantity: 2.5, occurredAtMs: 0 }));
    expect(agg.totalFor("tenant-a", "api_calls")).toBe(10);
    expect(agg.totalFor("tenant-a", "storage_gb")).toBe(2.5);
    expect(agg.totalsForTenant("tenant-a")).toEqual({ api_calls: 10, storage_gb: 2.5 });
  });

  it("keeps totals for different tenants fully independent", () => {
    const agg = new SlidingWindowAggregator({ bucketSizeMs: BUCKET_MS });
    agg.record(event({ tenantId: "tenant-a", quantity: 10, occurredAtMs: 0 }));
    agg.record(event({ tenantId: "tenant-b", quantity: 3, occurredAtMs: 0 }));
    expect(agg.totalFor("tenant-a", "api_calls")).toBe(10);
    expect(agg.totalFor("tenant-b", "api_calls")).toBe(3);
  });

  it("running total across a large in-order sequence matches a hand-computed expected sum", () => {
    const agg = new SlidingWindowAggregator({ bucketSizeMs: BUCKET_MS });
    let expectedTotal = 0;
    for (let i = 0; i < 1000; i++) {
      const quantity = (i % 7) + 1;
      agg.record(event({ quantity, occurredAtMs: i * 137 })); // in-order, scattered across many buckets
      expectedTotal += quantity;
    }
    expect(agg.totalFor("tenant-a", "api_calls")).toBe(expectedTotal);
  });
});
