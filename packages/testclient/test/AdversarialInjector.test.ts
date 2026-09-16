import { describe, expect, it } from "vitest";
import { generateGroundTruth } from "../src/GroundTruth.js";
import { buildAdversarialStream } from "../src/AdversarialInjector.js";

describe("buildAdversarialStream", () => {
  it("rejects a duplicateRate outside [0, 1]", () => {
    const gt = generateGroundTruth({ count: 5, seed: 1 });
    expect(() => buildAdversarialStream(gt, { seed: 1, duplicateRate: -0.1, reorder: false })).toThrow();
    expect(() => buildAdversarialStream(gt, { seed: 1, duplicateRate: 1.1, reorder: false })).toThrow();
  });

  it("with duplicateRate 0, produces exactly one (non-duplicate) submission per ground-truth event", () => {
    const gt = generateGroundTruth({ count: 30, seed: 1 });
    const stream = buildAdversarialStream(gt, { seed: 1, duplicateRate: 0, reorder: false });
    expect(stream).toHaveLength(30);
    expect(stream.every((s) => !s.isDuplicate)).toBe(true);
  });

  it("with duplicateRate 1, every ground-truth event gets exactly one duplicate (stream is exactly 2x length)", () => {
    const gt = generateGroundTruth({ count: 30, seed: 1 });
    const stream = buildAdversarialStream(gt, { seed: 1, duplicateRate: 1, reorder: false });
    expect(stream).toHaveLength(60);
    expect(stream.filter((s) => s.isDuplicate)).toHaveLength(30);
  });

  it("every duplicate submission carries the exact same event object as its original (same idempotencyKey and payload)", () => {
    const gt = generateGroundTruth({ count: 30, seed: 1 });
    const stream = buildAdversarialStream(gt, { seed: 1, duplicateRate: 1, reorder: false });
    for (const original of gt) {
      const copies = stream.filter((s) => s.event.idempotencyKey === original.idempotencyKey);
      expect(copies).toHaveLength(2);
      expect(copies[0]!.event).toEqual(copies[1]!.event);
    }
  });

  it("realizes approximately the target duplicate rate over a large stream (independent Bernoulli trials, not an exact quota)", () => {
    const gt = generateGroundTruth({ count: 5000, seed: 1 });
    const stream = buildAdversarialStream(gt, { seed: 1, duplicateRate: 0.5, reorder: false });
    const duplicateCount = stream.filter((s) => s.isDuplicate).length;
    const realizedRate = duplicateCount / gt.length;
    expect(realizedRate).toBeGreaterThan(0.45);
    expect(realizedRate).toBeLessThan(0.55);
  });

  it("without reorder, non-duplicate submissions preserve ground-truth generation order", () => {
    const gt = generateGroundTruth({ count: 30, seed: 1 });
    const stream = buildAdversarialStream(gt, { seed: 1, duplicateRate: 0, reorder: false });
    expect(stream.map((s) => s.event.idempotencyKey)).toEqual(gt.map((e) => e.idempotencyKey));
  });

  it("with reorder, the submission sequence is a permutation of the unreordered one, not merely a relabeling", () => {
    const gt = generateGroundTruth({ count: 100, seed: 1 });
    const unordered = buildAdversarialStream(gt, { seed: 1, duplicateRate: 0.3, reorder: false });
    const reordered = buildAdversarialStream(gt, { seed: 1, duplicateRate: 0.3, reorder: true });

    expect(reordered).toHaveLength(unordered.length);
    expect(reordered.map((s) => s.event.idempotencyKey).sort()).toEqual(
      unordered.map((s) => s.event.idempotencyKey).sort(),
    );
    expect(reordered.map((s) => s.event.idempotencyKey)).not.toEqual(
      unordered.map((s) => s.event.idempotencyKey),
    );
  });

  it("is fully deterministic for a given seed", () => {
    const gt = generateGroundTruth({ count: 50, seed: 5 });
    const a = buildAdversarialStream(gt, { seed: 99, duplicateRate: 0.4, reorder: true });
    const b = buildAdversarialStream(gt, { seed: 99, duplicateRate: 0.4, reorder: true });
    expect(b).toEqual(a);
  });
});
