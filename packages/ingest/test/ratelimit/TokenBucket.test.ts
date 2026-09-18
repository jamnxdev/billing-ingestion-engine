import { describe, expect, it } from "vitest";
import { TokenBucket } from "../../src/ratelimit/TokenBucket.js";

function fakeClock(startMs: number) {
  let now = startMs;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("TokenBucket", () => {
  it("rejects a non-positive capacity or refill rate", () => {
    expect(() => new TokenBucket(0, 1)).toThrow();
    expect(() => new TokenBucket(-1, 1)).toThrow();
    expect(() => new TokenBucket(1, 0)).toThrow();
    expect(() => new TokenBucket(1, -1)).toThrow();
  });

  it("allows up to `capacity` immediate consumptions with no elapsed time (burst)", () => {
    const bucket = new TokenBucket(5, 1, () => 0);
    for (let i = 0; i < 5; i++) {
      expect(bucket.tryConsume("tenant-a")).toBe(true);
    }
    expect(bucket.tryConsume("tenant-a")).toBe(false);
  });

  it("refills over time at the configured rate", () => {
    const clock = fakeClock(0);
    const bucket = new TokenBucket(1, 1, clock.now); // 1 token/sec, capacity 1
    expect(bucket.tryConsume("tenant-a")).toBe(true);
    expect(bucket.tryConsume("tenant-a")).toBe(false); // empty

    clock.advance(500); // half a second — half a token, still not enough
    expect(bucket.tryConsume("tenant-a")).toBe(false);

    clock.advance(500); // now a full second has passed since the last consume — one token available
    expect(bucket.tryConsume("tenant-a")).toBe(true);
  });

  it("never refills past capacity even after a very long idle period", () => {
    const clock = fakeClock(0);
    const bucket = new TokenBucket(3, 10, clock.now);
    bucket.tryConsume("tenant-a"); // tokens: 2
    clock.advance(1_000_000); // an enormous amount of time
    for (let i = 0; i < 3; i++) {
      expect(bucket.tryConsume("tenant-a")).toBe(true);
    }
    expect(bucket.tryConsume("tenant-a")).toBe(false); // capacity was never exceeded
  });

  it("tracks separate tenants completely independently", () => {
    const bucket = new TokenBucket(1, 1, () => 0);
    expect(bucket.tryConsume("tenant-a")).toBe(true);
    expect(bucket.tryConsume("tenant-a")).toBe(false);
    expect(bucket.tryConsume("tenant-b")).toBe(true); // unaffected by tenant-a's exhausted bucket
  });

  it("secondsUntilNextToken reports 0 when a token is available, and the correct wait otherwise", () => {
    const clock = fakeClock(0);
    const bucket = new TokenBucket(1, 2, clock.now); // 2 tokens/sec
    expect(bucket.secondsUntilNextToken("tenant-a")).toBe(0); // never touched — full bucket
    bucket.tryConsume("tenant-a");
    expect(bucket.tryConsume("tenant-a")).toBe(false);
    expect(bucket.secondsUntilNextToken("tenant-a")).toBeCloseTo(0.5, 5); // need 1 token at 2/sec
  });
});
