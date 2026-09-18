import { describe, expect, it } from "vitest";
import { runDedupLatencySweep } from "../src/DedupLatencyBenchmark.js";

describe("runDedupLatencySweep", () => {
  it("produces one result per configured window size", () => {
    const results = runDedupLatencySweep({
      windowSizesMs: [1000, 60_000, 3_600_000],
      targetOccupancy: 200,
      measuredCalls: 50,
    });
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.windowMs)).toEqual([1000, 60_000, 3_600_000]);
  });

  it("reaches the target steady-state occupancy regardless of window size — the scaling this benchmark depends on to be a fair comparison", () => {
    const results = runDedupLatencySweep({
      windowSizesMs: [1000, 3_600_000],
      targetOccupancy: 500,
      measuredCalls: 100,
    });
    for (const r of results) {
      // Each measured call inserts one new entry and evicts ~one old one, so
      // occupancy should stay very close to the target throughout, not just
      // at the warmup boundary.
      expect(r.storeSizeAfter).toBeGreaterThanOrEqual(499);
      expect(r.storeSizeAfter).toBeLessThanOrEqual(501);
    }
  });

  it("reports the requested number of measured calls", () => {
    const [result] = runDedupLatencySweep({
      windowSizesMs: [10_000],
      targetOccupancy: 100,
      measuredCalls: 250,
    });
    expect(result!.measuredCalls).toBe(250);
  });
});
