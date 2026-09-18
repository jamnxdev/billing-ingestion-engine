import { buildServer } from "@billing/ingest";
import { computePercentiles } from "./percentiles.js";

export interface ThroughputSweepOptions {
  concurrencyLevels: readonly number[];
  /** Excluded from measurement — lets Node's JIT and connection pool warm up before timing starts. */
  warmupMs: number;
  measuredMs: number;
  dedupWindowMs: number;
  bucketSizeMs: number;
}

export interface ThroughputLevelResult {
  concurrency: number;
  measuredMs: number;
  requestsCompleted: number;
  throughputPerSec: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  /**
   * Round-trip time of a single GET /aggregates query issued immediately
   * after the load stops — the concrete, measured stand-in for "aggregation
   * lag" (metric #3). This design applies every accepted event synchronously
   * in-request (see server.ts), so there is no separate materialization
   * delay to measure beyond an ordinary query's own latency; this number is
   * the evidence for that claim, not an assumption.
   */
  postLoadQueryLatencyMs: number;
}

const TENANT = "tenant-throughput";
const METRIC = "api_calls";
const API_KEY = "throughput-bench-key";

async function startBenchServer(dedupWindowMs: number, bucketSizeMs: number) {
  const app = buildServer({
    dedupWindowMs,
    bucketSizeMs,
    apiKeys: { [API_KEY]: TENANT },
    // Deliberately unlimited: this benchmark measures the ingestion pipeline's
    // own throughput ceiling, not the rate limiter's — a separate, orthogonal concern.
    rateLimit: { requestsPerSecond: 1_000_000_000, burstCapacity: 1_000_000_000 },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("could not determine the bench server's listening port");
  }
  return { baseUrl: `http://127.0.0.1:${address.port}`, close: () => app.close() };
}

async function runLevel(
  baseUrl: string,
  concurrency: number,
  warmupMs: number,
  measuredMs: number,
): Promise<ThroughputLevelResult> {
  const samples: number[] = [];
  const start = Date.now();
  const deadline = start + warmupMs + measuredMs;

  async function worker(workerId: number): Promise<void> {
    let seq = 0;
    while (Date.now() < deadline) {
      const event = {
        tenantId: TENANT,
        metric: METRIC,
        idempotencyKey: `w${workerId}-${seq++}`,
        quantity: 1,
        occurredAtMs: Date.now(),
      };
      const t0 = performance.now();
      const res = await fetch(`${baseUrl}/events`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": API_KEY },
        body: JSON.stringify(event),
      });
      await res.arrayBuffer(); // drain the body so the connection can be reused
      const elapsedMs = performance.now() - t0;
      if (Date.now() - start >= warmupMs) {
        samples.push(elapsedMs);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));

  const queryStart = performance.now();
  const queryRes = await fetch(`${baseUrl}/aggregates/${TENANT}?metric=${METRIC}`);
  await queryRes.json();
  const postLoadQueryLatencyMs = performance.now() - queryStart;

  const { p50, p95, p99, max } = computePercentiles(samples);
  return {
    concurrency,
    measuredMs,
    requestsCompleted: samples.length,
    throughputPerSec: samples.length / (measuredMs / 1000),
    p50Ms: p50,
    p95Ms: p95,
    p99Ms: p99,
    maxMs: max,
    postLoadQueryLatencyMs,
  };
}

/**
 * Sweeps sustained ingestion throughput across ramping concurrency levels,
 * over real HTTP (not `inject()` — throughput is fundamentally about I/O and
 * connection-handling behavior that in-process injection bypasses entirely).
 * Each level gets a freshly started server, so dedup-store/aggregator state
 * from one level can't skew the next.
 */
export async function runThroughputSweep(
  options: ThroughputSweepOptions,
): Promise<ThroughputLevelResult[]> {
  const results: ThroughputLevelResult[] = [];
  for (const concurrency of options.concurrencyLevels) {
    const { baseUrl, close } = await startBenchServer(options.dedupWindowMs, options.bucketSizeMs);
    try {
      results.push(await runLevel(baseUrl, concurrency, options.warmupMs, options.measuredMs));
    } finally {
      await close();
    }
  }
  return results;
}
