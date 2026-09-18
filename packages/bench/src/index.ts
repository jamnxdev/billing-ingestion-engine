export {
  runCorrectnessSweep,
  summarize,
  runLateDuplicateBeyondWindowScenario,
  type CorrectnessTrialResult,
  type CorrectnessRateSummary,
  type CorrectnessSweepOptions,
  type LateDuplicateScenarioResult,
  type Design,
} from "./CorrectnessBenchmark.js";
export { toCsv } from "./csv.js";
export { computePercentiles, type Percentiles } from "./percentiles.js";
export {
  runThroughputSweep,
  type ThroughputSweepOptions,
  type ThroughputLevelResult,
} from "./ThroughputBenchmark.js";
export {
  runDedupLatencySweep,
  type DedupLatencyOptions,
  type DedupLatencyResult,
} from "./DedupLatencyBenchmark.js";
