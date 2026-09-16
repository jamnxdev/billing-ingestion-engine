import { describe, expect, it } from "vitest";
import { generateGroundTruth, groundTruthTotal } from "../src/GroundTruth.js";

describe("generateGroundTruth", () => {
  it("is fully deterministic for a given seed", () => {
    const a = generateGroundTruth({ count: 50, seed: 42 });
    const b = generateGroundTruth({ count: 50, seed: 42 });
    expect(b).toEqual(a);
  });

  it("produces a different stream for a different seed", () => {
    const a = generateGroundTruth({ count: 50, seed: 1 });
    const b = generateGroundTruth({ count: 50, seed: 2 });
    expect(b).not.toEqual(a);
  });

  it("generates the requested count with unique idempotency keys", () => {
    const events = generateGroundTruth({ count: 100, seed: 7 });
    expect(events).toHaveLength(100);
    expect(new Set(events.map((e) => e.idempotencyKey)).size).toBe(100);
  });

  it("respects quantity and occurredAtMs ranges", () => {
    const events = generateGroundTruth({
      count: 200,
      seed: 3,
      quantityRange: [5, 5],
      occurredAtMsRange: [1000, 1000],
    });
    expect(events.every((e) => e.quantity === 5)).toBe(true);
    expect(events.every((e) => e.occurredAtMs === 1000)).toBe(true);
  });

  it("defaults to a single tenant and metric", () => {
    const events = generateGroundTruth({ count: 20, seed: 9 });
    expect(new Set(events.map((e) => e.tenantId))).toEqual(new Set(["tenant-bench"]));
    expect(new Set(events.map((e) => e.metric))).toEqual(new Set(["api_calls"]));
  });
});

describe("groundTruthTotal", () => {
  it("sums every event's quantity", () => {
    const events = generateGroundTruth({ count: 10, seed: 1, quantityRange: [1, 1] });
    expect(groundTruthTotal(events)).toBe(10);
  });

  it("returns 0 for an empty stream", () => {
    expect(groundTruthTotal([])).toBe(0);
  });
});
