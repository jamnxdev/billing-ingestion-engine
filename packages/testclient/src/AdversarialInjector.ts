import type { UsageEvent } from "@billing/aggregator";
import { Mulberry32 } from "./random/Mulberry32.js";

export interface InjectorOptions {
  seed: number;
  /**
   * Fraction (0..1) of ground-truth events that get one extra duplicate
   * submission injected. Applied as an independent Bernoulli trial per
   * event, not an exact quota — e.g. `duplicateRate: 0.1` means each event
   * is duplicated with 10% probability, so the realized rate over a finite
   * stream is *approximately*, not exactly, 10%. Documented explicitly since
   * it's a real modeling choice, not a precision bug.
   */
  duplicateRate: number;
  /**
   * Whether the final submission order is shuffled relative to generation
   * order. Reordering only ever changes *arrival order* — the event's own
   * `occurredAtMs` never changes, matching the rest of this project's design
   * (aggregation attribution and dedup are both independent of arrival
   * order by construction; this is what the injector is stress-testing).
   */
  reorder: boolean;
}

export interface ScheduledSubmission {
  event: UsageEvent;
  /** True for the injected extra copy of an event, false for its original submission. */
  isDuplicate: boolean;
}

/**
 * Builds the actual wire-order sequence of submissions an adversarial
 * client would send: some ground-truth events get a byte-for-byte duplicate
 * submission injected, and (if `reorder` is set) the whole sequence is
 * shuffled — modeling duplicate delivery and out-of-order arrival, the two
 * conditions the spec's correctness benchmark is built around.
 *
 * Delay is deliberately not modeled as a per-submission wall-clock wait
 * here: a real network delay affects *when* a request lands relative to a
 * server-side clock, which this project already represents directly via an
 * injectable clock (`buildServer`'s `clock` option, since Day 1) — the
 * dedicated "duplicate arrives after the dedup window has expired" scenario
 * is built by directly advancing that fake clock in the benchmark harness
 * rather than by teaching this injector to simulate real elapsed time. That
 * keeps the correctness benchmark deterministic and instant to run, with no
 * real waiting, while still exercising the exact condition a delay would
 * cause.
 */
export function buildAdversarialStream(
  groundTruth: readonly UsageEvent[],
  options: InjectorOptions,
): ScheduledSubmission[] {
  if (options.duplicateRate < 0 || options.duplicateRate > 1) {
    throw new Error(`duplicateRate must be in [0, 1], got ${options.duplicateRate}`);
  }

  const rng = new Mulberry32(options.seed);
  const submissions: ScheduledSubmission[] = [];
  for (const event of groundTruth) {
    submissions.push({ event, isDuplicate: false });
    if (rng.nextBool(options.duplicateRate)) {
      submissions.push({ event, isDuplicate: true });
    }
  }

  return options.reorder ? rng.shuffle(submissions) : submissions;
}
