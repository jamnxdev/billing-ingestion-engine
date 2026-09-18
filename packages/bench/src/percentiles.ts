export interface Percentiles {
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

/**
 * Nearest-rank percentiles from a raw sample array — sorts once, then picks
 * by index. No streaming histogram (HdrHistogram-style) needed at this
 * project's sample sizes (tens of thousands per run at most): sorting an
 * array that size is microseconds, and a plain sorted array is trivially
 * easy to unit-test against a hand-computed expectation, which a
 * bucketed/approximate histogram implementation would not be.
 */
export function computePercentiles(samples: readonly number[]): Percentiles {
  if (samples.length === 0) {
    return { p50: 0, p95: 0, p99: 0, max: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
  return {
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted[sorted.length - 1]!,
  };
}
