import { DedupStore } from "@billing/ingest";
import { computePercentiles, type Percentiles } from "./percentiles.js";

export interface DedupLatencyOptions {
  windowSizesMs: readonly number[];
  /**
   * Held constant across every window size — the controlled variable. Window
   * size and live-entry occupancy are two different things that both plausibly
   * affect `check()` cost; varying window size while holding occupancy fixed
   * isolates window size as the only thing that changes between rows, exactly
   * the "change one variable at a time" discipline the rest of this project's
   * benchmarks already follow.
   */
  targetOccupancy: number;
  measuredCalls: number;
}

export interface DedupLatencyResult {
  windowMs: number;
  targetOccupancy: number;
  measuredCalls: number;
  storeSizeAfter: number;
  p50Us: Percentiles["p50"];
  p95Us: Percentiles["p95"];
  p99Us: Percentiles["p99"];
  maxUs: Percentiles["max"];
}

/**
 * Measures `DedupStore.check()` latency at a fixed steady-state occupancy,
 * across several window sizes spanning three orders of magnitude — the
 * direct evidence for (or against) the Day 1 design claim that eviction is
 * O(1) amortized regardless of window size, because entries expire in
 * exactly insertion order (see `DedupStore`'s own doc comment).
 *
 * For a given `windowMs`, the "tick" between calls is scaled to
 * `windowMs / targetOccupancy`, so exactly `targetOccupancy` warmup calls are
 * needed to reach steady state (the point where each new insert causes
 * roughly one eviction) regardless of how large `windowMs` itself is — this
 * is what makes a 1-hour window and a 1-second window both measurable in a
 * few milliseconds of real wall-clock time: the fake clock advances by the
 * scaled tick, not real time.
 */
export function runDedupLatencySweep(options: DedupLatencyOptions): DedupLatencyResult[] {
  const results: DedupLatencyResult[] = [];

  for (const windowMs of options.windowSizesMs) {
    const tickMs = windowMs / options.targetOccupancy;
    let now = 0;
    const store = new DedupStore(windowMs, () => now);

    // Warmup: fill the store to steady-state occupancy. Not measured — this
    // phase is dominated by insert-only cost (no evictions yet), which is not
    // representative of sustained-load behavior.
    for (let i = 0; i < options.targetOccupancy; i++) {
      store.check("tenant-bench", `warmup-${i}`, "h");
      now += tickMs;
    }

    // Measured: every call here is a fresh, unique key at steady-state
    // occupancy, so each insert triggers ~one eviction of the oldest entry —
    // exactly the sustained-load condition this benchmark is measuring.
    const samplesUs: number[] = [];
    for (let i = 0; i < options.measuredCalls; i++) {
      const t0 = performance.now();
      store.check("tenant-bench", `measured-${i}`, "h");
      samplesUs.push((performance.now() - t0) * 1000);
      now += tickMs;
    }

    const { p50, p95, p99, max } = computePercentiles(samplesUs);
    results.push({
      windowMs,
      targetOccupancy: options.targetOccupancy,
      measuredCalls: options.measuredCalls,
      storeSizeAfter: store.size(),
      p50Us: p50,
      p95Us: p95,
      p99Us: p99,
      maxUs: max,
    });
  }

  return results;
}
