import { describe, expect, it } from "vitest";
import { SlidingWindowAggregator } from "../src/SlidingWindowAggregator.js";
import type { UsageEvent } from "../src/types/UsageEvent.js";

const BUCKET_MS = 60_000;

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

describe("SlidingWindowAggregator — hand-picked boundary/out-of-order scenarios", () => {
  it("attributes events straddling a bucket boundary correctly when submitted in reverse chronological order", () => {
    const agg = new SlidingWindowAggregator({ bucketSizeMs: BUCKET_MS });
    // Reverse arrival order: the event for the *later* bucket arrives first.
    agg.record(event({ idempotencyKey: "k3", quantity: 3, occurredAtMs: BUCKET_MS + 1 })); // bucket 60_000
    agg.record(event({ idempotencyKey: "k2", quantity: 2, occurredAtMs: BUCKET_MS })); // bucket 60_000 (boundary)
    agg.record(event({ idempotencyKey: "k1", quantity: 1, occurredAtMs: BUCKET_MS - 1 })); // bucket 0

    expect(agg.bucketsFor("tenant-a", "api_calls")).toEqual(
      new Map([
        [0, 1],
        [BUCKET_MS, 5], // 3 + 2, both correctly in the later bucket despite arriving out of order
      ]),
    );
  });

  it("a very late-arriving event still lands in its own correct (old) bucket, not the bucket of whatever arrived most recently", () => {
    const agg = new SlidingWindowAggregator({ bucketSizeMs: BUCKET_MS });
    // Ten "recent" events arrive first, each in its own later bucket.
    for (let i = 1; i <= 10; i++) {
      agg.record(event({ idempotencyKey: `recent-${i}`, quantity: 1, occurredAtMs: i * BUCKET_MS }));
    }
    // A single event for bucket 0 arrives dead last, long after everything else.
    agg.record(event({ idempotencyKey: "late", quantity: 42, occurredAtMs: 0 }));

    expect(agg.bucketsFor("tenant-a", "api_calls").get(0)).toBe(42);
    expect(agg.totalFor("tenant-a", "api_calls")).toBe(42 + 10);
  });

  it("interleaves out-of-order events across three tenants and two metrics without cross-contamination", () => {
    const agg = new SlidingWindowAggregator({ bucketSizeMs: BUCKET_MS });
    const submissions: UsageEvent[] = [
      event({ tenantId: "t1", metric: "api_calls", quantity: 5, occurredAtMs: 3 * BUCKET_MS }),
      event({ tenantId: "t2", metric: "storage_gb", quantity: 1, occurredAtMs: 0 }),
      event({ tenantId: "t1", metric: "api_calls", quantity: 2, occurredAtMs: 0 }),
      event({ tenantId: "t2", metric: "storage_gb", quantity: 4, occurredAtMs: 2 * BUCKET_MS }),
      event({ tenantId: "t1", metric: "storage_gb", quantity: 9, occurredAtMs: BUCKET_MS }),
    ];
    submissions.forEach((e, i) => agg.record({ ...e, idempotencyKey: `k${i}` }));

    expect(agg.totalFor("t1", "api_calls")).toBe(7); // 5 + 2
    expect(agg.totalFor("t1", "storage_gb")).toBe(9);
    expect(agg.totalFor("t2", "storage_gb")).toBe(5); // 1 + 4
    expect(agg.totalFor("t2", "api_calls")).toBe(0); // t2 never reported this metric
  });

  it("documents the boundary-loss trade explicitly: an arbitrarily late event is never lost, because buckets are never evicted", () => {
    const agg = new SlidingWindowAggregator({ bucketSizeMs: BUCKET_MS });
    agg.record(event({ idempotencyKey: "k1", quantity: 100, occurredAtMs: 0 }));
    // Simulate a huge amount of elapsed "wall-clock" time passing (represented here
    // only by other events being recorded for far-future buckets — the aggregator
    // has no notion of "now" at all, which is exactly what guarantees this).
    for (let i = 1; i <= 1000; i++) {
      agg.record(event({ idempotencyKey: `future-${i}`, quantity: 1, occurredAtMs: i * BUCKET_MS }));
    }
    // The bucket-0 event from "long ago" is still there, untouched and correct.
    expect(agg.bucketsFor("tenant-a", "api_calls").get(0)).toBe(100);
  });
});
