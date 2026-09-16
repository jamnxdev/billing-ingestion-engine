/**
 * A tiny, dependency-free seeded PRNG (mulberry32). Not cryptographic —
 * chosen specifically because the entire point of every generator/injector
 * in this package is exact reproducibility from a seed: a failing adversarial
 * scenario must be replayable byte-for-byte from just its seed, the same way
 * `Math.random()` deliberately cannot be.
 */
export class Mulberry32 {
  private state: number;

  constructor(seed: number) {
    this.state = seed | 0;
  }

  /** Next pseudo-random float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max] inclusive. */
  nextInt(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** True with probability `p` (0..1). */
  nextBool(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(0, items.length - 1)]!;
  }

  /** In-place Fisher-Yates shuffle of a copy of `items`. */
  shuffle<T>(items: readonly T[]): T[] {
    const result = items.slice();
    for (let i = result.length - 1; i > 0; i--) {
      const j = this.nextInt(0, i);
      [result[i], result[j]] = [result[j]!, result[i]!];
    }
    return result;
  }
}
