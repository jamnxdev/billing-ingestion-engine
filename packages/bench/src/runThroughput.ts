import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runThroughputSweep } from "./ThroughputBenchmark.js";
import { toCsv } from "./csv.js";

const RESULTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "results");

const CONCURRENCY_LEVELS = [1, 5, 20, 50, 100];
const WARMUP_MS = 500;
const MEASURED_MS = 2000;
const DEDUP_WINDOW_MS = 5 * 60 * 1000;
const BUCKET_SIZE_MS = 60 * 1000;

async function main() {
  await mkdir(RESULTS_DIR, { recursive: true });

  console.log(
    `Running throughput sweep: concurrency levels ${CONCURRENCY_LEVELS.join(", ")}, ${WARMUP_MS}ms warmup + ${MEASURED_MS}ms measured per level...`,
  );
  const results = await runThroughputSweep({
    concurrencyLevels: CONCURRENCY_LEVELS,
    warmupMs: WARMUP_MS,
    measuredMs: MEASURED_MS,
    dedupWindowMs: DEDUP_WINDOW_MS,
    bucketSizeMs: BUCKET_SIZE_MS,
  });

  await writeFile(path.join(RESULTS_DIR, "throughput.csv"), toCsv(results));

  console.log("\nconcurrency  throughput/s  p50ms   p95ms   p99ms    maxms    postLoadQueryMs");
  for (const r of results) {
    console.log(
      `${String(r.concurrency).padStart(11)}  ${r.throughputPerSec.toFixed(0).padStart(12)}  ` +
        `${r.p50Ms.toFixed(2).padStart(6)}  ${r.p95Ms.toFixed(2).padStart(6)}  ${r.p99Ms.toFixed(2).padStart(6)}   ` +
        `${r.maxMs.toFixed(2).padStart(7)}  ${r.postLoadQueryLatencyMs.toFixed(2).padStart(15)}`,
    );
  }

  console.log(`\nRaw results written to ${path.join(RESULTS_DIR, "throughput.csv")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
