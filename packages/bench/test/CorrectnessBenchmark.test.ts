import { describe, expect, it } from "vitest";
import {
  runCorrectnessSweep,
  summarize,
  runLateDuplicateBeyondWindowScenario,
  type CorrectnessTrialResult,
} from "../src/CorrectnessBenchmark.js";

describe("runCorrectnessSweep", () => {
  it("with duplicateRate 0, both the correct and naive designs match ground truth exactly (no duplicates to mishandle)", async () => {
    const results = await runCorrectnessSweep({
      duplicateRates: [0],
      trialsPerRate: 3,
      eventsPerTrial: 20,
      dedupWindowMs: 60_000,
      bucketSizeMs: 60_000,
      baseSeed: 1,
    });
    expect(results.every((r) => r.matches)).toBe(true);
  });

  it("with duplicateRate 1, the correct design always matches and the naive design never does", async () => {
    const results = await runCorrectnessSweep({
      duplicateRates: [1],
      trialsPerRate: 5,
      eventsPerTrial: 20,
      dedupWindowMs: 60_000,
      bucketSizeMs: 60_000,
      baseSeed: 2,
    });
    const correct = results.filter((r) => r.design === "correct");
    const naive = results.filter((r) => r.design === "naive");
    expect(correct).toHaveLength(5);
    expect(naive).toHaveLength(5);
    expect(correct.every((r) => r.matches)).toBe(true);
    expect(naive.every((r) => !r.matches)).toBe(true);
    // Every naive trial should have billed exactly double the ground truth,
    // since duplicateRate 1 means every event is duplicated exactly once.
    for (const r of naive) {
      expect(r.actualTotal).toBe(r.groundTruthTotal * 2);
    }
  });

  it("produces the requested number of trials per duplicate rate, across multiple rates", async () => {
    const results = await runCorrectnessSweep({
      duplicateRates: [0, 0.5],
      trialsPerRate: 4,
      eventsPerTrial: 10,
      dedupWindowMs: 60_000,
      bucketSizeMs: 60_000,
      baseSeed: 3,
    });
    // 2 rates x 4 trials x 2 designs
    expect(results).toHaveLength(2 * 4 * 2);
  });
});

describe("summarize", () => {
  it("collapses raw trial results into a correctness rate per (duplicateRate, design)", () => {
    const raw: CorrectnessTrialResult[] = [
      { duplicateRate: 0.1, trial: 0, design: "correct", groundTruthTotal: 10, actualTotal: 10, matches: true },
      { duplicateRate: 0.1, trial: 1, design: "correct", groundTruthTotal: 10, actualTotal: 10, matches: true },
      { duplicateRate: 0.1, trial: 0, design: "naive", groundTruthTotal: 10, actualTotal: 11, matches: false },
      { duplicateRate: 0.1, trial: 1, design: "naive", groundTruthTotal: 10, actualTotal: 10, matches: true },
    ];
    const summary = summarize(raw);
    expect(summary).toEqual([
      { duplicateRate: 0.1, design: "correct", trials: 2, matches: 2, correctnessRate: 1 },
      { duplicateRate: 0.1, design: "naive", trials: 2, matches: 1, correctnessRate: 0.5 },
    ]);
  });

  it("returns an empty summary for empty input", () => {
    expect(summarize([])).toEqual([]);
  });
});

describe("runLateDuplicateBeyondWindowScenario", () => {
  it("demonstrates that even the correct design double-counts a duplicate that arrives after the dedup window has expired", async () => {
    const result = await runLateDuplicateBeyondWindowScenario(1000, 60_000);
    expect(result.duplicateWasRecognizedAsSuch).toBe(false);
    expect(result.actualTotal).toBe(result.originalQuantity + result.duplicateQuantity);
    expect(result.actualTotal).not.toBe(result.correctTotalIfWithinWindow);
  });
});
