import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runDedupLatencySweep } from "./DedupLatencyBenchmark.js";
import { toCsv } from "./csv.js";

const RESULTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "results");

const WINDOW_SIZES_MS = [1_000, 60_000, 5 * 60_000, 60 * 60_000]; // 1s, 1min, 5min, 1hr
const TARGET_OCCUPANCY = 10_000;
const MEASURED_CALLS = 20_000;

async function main() {
  await mkdir(RESULTS_DIR, { recursive: true });

  console.log(
    `Running dedup-latency sweep: window sizes ${WINDOW_SIZES_MS.join(", ")}ms, occupancy held at ${TARGET_OCCUPANCY}, ${MEASURED_CALLS} measured calls per window...`,
  );
  const results = runDedupLatencySweep({
    windowSizesMs: WINDOW_SIZES_MS,
    targetOccupancy: TARGET_OCCUPANCY,
    measuredCalls: MEASURED_CALLS,
  });

  await writeFile(path.join(RESULTS_DIR, "dedup-latency.csv"), toCsv(results));

  console.log("\nwindowMs    occupancy  p50us   p95us   p99us    maxus");
  for (const r of results) {
    console.log(
      `${String(r.windowMs).padStart(8)}  ${String(r.storeSizeAfter).padStart(9)}  ` +
        `${r.p50Us.toFixed(2).padStart(6)}  ${r.p95Us.toFixed(2).padStart(6)}  ${r.p99Us.toFixed(2).padStart(6)}   ${r.maxUs.toFixed(2).padStart(7)}`,
    );
  }

  console.log(`\nRaw results written to ${path.join(RESULTS_DIR, "dedup-latency.csv")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
