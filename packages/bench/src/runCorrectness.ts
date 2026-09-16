import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runCorrectnessSweep,
  summarize,
  runLateDuplicateBeyondWindowScenario,
} from "./CorrectnessBenchmark.js";
import { toCsv } from "./csv.js";

const RESULTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "results");

const DUPLICATE_RATES = [0, 0.1, 0.5, 0.9];
const TRIALS_PER_RATE = 20;
const EVENTS_PER_TRIAL = 200;
const DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes — generously larger than the sweep's own elapsed virtual time (~400ms at 400 events x 1ms/tick)
const BUCKET_SIZE_MS = 60 * 1000;

async function main() {
  await mkdir(RESULTS_DIR, { recursive: true });

  console.log(
    `Running correctness sweep: ${DUPLICATE_RATES.length} duplicate rates x ${TRIALS_PER_RATE} trials x ${EVENTS_PER_TRIAL} events/trial x 2 designs...`,
  );
  const results = await runCorrectnessSweep({
    duplicateRates: DUPLICATE_RATES,
    trialsPerRate: TRIALS_PER_RATE,
    eventsPerTrial: EVENTS_PER_TRIAL,
    dedupWindowMs: DEDUP_WINDOW_MS,
    bucketSizeMs: BUCKET_SIZE_MS,
    baseSeed: 1_000,
  });

  await writeFile(path.join(RESULTS_DIR, "correctness-raw.csv"), toCsv(results));

  const summary = summarize(results);
  await writeFile(path.join(RESULTS_DIR, "correctness-summary.csv"), toCsv(summary));

  console.log("\nCorrectness rate (duplicate rate vs. billing accuracy):\n");
  console.log("duplicateRate  design   correctnessRate  (matches/trials)");
  for (const row of summary) {
    console.log(
      `${(row.duplicateRate * 100).toFixed(0).padStart(3)}%          ${row.design.padEnd(8)} ${(row.correctnessRate * 100).toFixed(1).padStart(5)}%           (${row.matches}/${row.trials})`,
    );
  }

  // One concrete "how wrong would naive billing be" example, from the highest duplicate rate's first trial.
  const worstNaive = results.find(
    (r) => r.design === "naive" && r.duplicateRate === Math.max(...DUPLICATE_RATES) && r.trial === 0,
  )!;
  console.log(
    `\nConcrete example at ${(worstNaive.duplicateRate * 100).toFixed(0)}% duplicate rate: naive billed ${worstNaive.actualTotal} units against a true ${worstNaive.groundTruthTotal} units ` +
      `(${(((worstNaive.actualTotal - worstNaive.groundTruthTotal) / worstNaive.groundTruthTotal) * 100).toFixed(1)}% over-billed).`,
  );

  console.log("\nLate-duplicate-beyond-window scenario (the documented dedup-window boundary):\n");
  const lateScenario = await runLateDuplicateBeyondWindowScenario(DEDUP_WINDOW_MS, BUCKET_SIZE_MS);
  console.log(JSON.stringify(lateScenario, null, 2));
  await writeFile(
    path.join(RESULTS_DIR, "late-duplicate-scenario.json"),
    JSON.stringify(lateScenario, null, 2) + "\n",
  );

  console.log(`\nRaw results written to ${RESULTS_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
