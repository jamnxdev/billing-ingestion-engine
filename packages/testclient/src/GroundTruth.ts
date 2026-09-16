import type { UsageEvent } from "@billing/aggregator";
import { Mulberry32 } from "./random/Mulberry32.js";

export interface GroundTruthOptions {
  count: number;
  seed: number;
  tenantId?: string;
  metric?: string;
  quantityRange?: [number, number];
  occurredAtMsRange?: [number, number];
}

/**
 * Generates a deterministic, seeded set of "real" (ground-truth) usage
 * events — each with a globally unique `idempotencyKey` (`gt-0`, `gt-1`,
 * ...), a single tenant+metric by default so the resulting ground-truth
 * total is a single number, trivial to state and compare against.
 *
 * Deliberately a single tenant/metric for the correctness benchmark's main
 * sweep — Day 2/3 already proved multi-tenant/multi-metric independence
 * directly; this generator's job is producing a stream whose "correct
 * answer" is unambiguous and easy to verify by eye, not re-proving isolation
 * that's already covered elsewhere.
 */
export function generateGroundTruth(options: GroundTruthOptions): UsageEvent[] {
  const {
    count,
    seed,
    tenantId = "tenant-bench",
    metric = "api_calls",
    quantityRange = [1, 100],
    occurredAtMsRange = [0, 10_000_000],
  } = options;

  const rng = new Mulberry32(seed);
  const events: UsageEvent[] = [];
  for (let i = 0; i < count; i++) {
    events.push({
      tenantId,
      metric,
      idempotencyKey: `gt-${i}`,
      quantity: rng.nextInt(quantityRange[0], quantityRange[1]),
      occurredAtMs: rng.nextInt(occurredAtMsRange[0], occurredAtMsRange[1]),
    });
  }
  return events;
}

/** The offline, server-independent "correct answer": sum of every ground-truth event's quantity. */
export function groundTruthTotal(events: readonly UsageEvent[]): number {
  return events.reduce((sum, e) => sum + e.quantity, 0);
}
