import type { UsageEvent } from "./types/UsageEvent.js";

export interface AggregatorOptions {
  /**
   * Bucket width, in milliseconds, that events are grouped into by
   * `occurredAtMs`. Buckets are the unit of exact attribution — every event
   * is added to exactly one bucket, determined by its own event time, never
   * by arrival/receipt time. This is what makes out-of-order *arrival*
   * (Day 3) a non-issue for correctness as long as the event still arrives:
   * a late-arriving event for an old bucket is still added to that same old
   * bucket and correctly reflected in the running total.
   */
  bucketSizeMs: number;
}

/**
 * Per-tenant, per-metric running usage totals, bucketed by event time.
 *
 * Deliberately a **cumulative running total**, not a rolling window relative
 * to "now" — confirmed with the user, since "sliding-window aggregation"
 * could plausibly mean either. A billing total must never shrink as time
 * passes (a rate-limiter-style "usage in the last N minutes" window would);
 * bucketing is used purely as the mechanism for *exact, replay-stable event
 * attribution*, not as a retention/eviction boundary. No bucket is ever
 * evicted here — unbounded growth in bucket count over the lifetime of a
 * tenant+metric pair is a known, explicitly accepted Day 2 limitation (see
 * the implementation log), not an oversight.
 */
export class SlidingWindowAggregator {
  private readonly bucketSizeMs: number;

  // tenantId -> metric -> bucketStartMs -> summed quantity
  private readonly perTenant = new Map<string, Map<string, Map<number, number>>>();

  constructor(options: AggregatorOptions) {
    if (options.bucketSizeMs <= 0) {
      throw new Error(`bucketSizeMs must be positive, got ${options.bucketSizeMs}`);
    }
    this.bucketSizeMs = options.bucketSizeMs;
  }

  /**
   * Applies an already-deduplicated event to the running totals. Callers
   * (the ingestion API) are responsible for ensuring this is only called
   * once per logically-distinct event — the aggregator itself has no
   * idempotency notion of its own and will happily double-count a call
   * invoked twice for the same event, by design: that concern belongs to
   * `DedupStore`, one layer up, not duplicated here.
   */
  record(event: UsageEvent): void {
    const bucketStart = this.bucketOf(event.occurredAtMs);
    const metricMap = this.getOrCreateMetricMap(event.tenantId, event.metric);
    metricMap.set(bucketStart, (metricMap.get(bucketStart) ?? 0) + event.quantity);
  }

  /** Running total for one tenant+metric pair, summed across every bucket recorded so far. */
  totalFor(tenantId: string, metric: string): number {
    const metricMap = this.perTenant.get(tenantId)?.get(metric);
    if (metricMap === undefined) {
      return 0;
    }
    let sum = 0;
    for (const quantity of metricMap.values()) {
      sum += quantity;
    }
    return sum;
  }

  /** Running totals for every metric this tenant has ever reported, keyed by metric name. */
  totalsForTenant(tenantId: string): Record<string, number> {
    const tenantMap = this.perTenant.get(tenantId);
    if (tenantMap === undefined) {
      return {};
    }
    const totals: Record<string, number> = {};
    for (const metric of tenantMap.keys()) {
      totals[metric] = this.totalFor(tenantId, metric);
    }
    return totals;
  }

  /**
   * Read-only view of the individual buckets behind one tenant+metric's
   * total, keyed by bucket start (ms). Exposed for tests/audit — proves
   * *how* a total was assembled, not just its final value — and for Day 3's
   * boundary-condition tests, which need to assert exactly which bucket an
   * event landed in.
   */
  bucketsFor(tenantId: string, metric: string): ReadonlyMap<number, number> {
    return this.perTenant.get(tenantId)?.get(metric) ?? new Map();
  }

  private bucketOf(occurredAtMs: number): number {
    return Math.floor(occurredAtMs / this.bucketSizeMs) * this.bucketSizeMs;
  }

  private getOrCreateMetricMap(tenantId: string, metric: string): Map<number, number> {
    let tenantMap = this.perTenant.get(tenantId);
    if (tenantMap === undefined) {
      tenantMap = new Map();
      this.perTenant.set(tenantId, tenantMap);
    }
    let metricMap = tenantMap.get(metric);
    if (metricMap === undefined) {
      metricMap = new Map();
      tenantMap.set(metric, metricMap);
    }
    return metricMap;
  }
}
