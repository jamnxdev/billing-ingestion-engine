import { describe, expect, it } from "vitest";
import { computePercentiles } from "../src/percentiles.js";

describe("computePercentiles", () => {
  it("returns all zeros for an empty sample set", () => {
    expect(computePercentiles([])).toEqual({ p50: 0, p95: 0, p99: 0, max: 0 });
  });

  it("returns the single value for every percentile when there is exactly one sample", () => {
    expect(computePercentiles([42])).toEqual({ p50: 42, p95: 42, p99: 42, max: 42 });
  });

  it("computes nearest-rank percentiles against a hand-verifiable 100-element set", () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    const result = computePercentiles(samples);
    expect(result.p50).toBe(51); // floor(0.50 * 100) = index 50 -> value 51
    expect(result.p95).toBe(96); // floor(0.95 * 100) = index 95 -> value 96
    expect(result.p99).toBe(100); // floor(0.99 * 100) = index 99 -> value 100
    expect(result.max).toBe(100);
  });

  it("does not depend on input order", () => {
    const ordered = computePercentiles([1, 2, 3, 4, 5]);
    const shuffled = computePercentiles([3, 1, 5, 2, 4]);
    expect(shuffled).toEqual(ordered);
  });

  it("does not mutate the input array", () => {
    const samples = [5, 3, 1, 4, 2];
    const copy = [...samples];
    computePercentiles(samples);
    expect(samples).toEqual(copy);
  });
});
