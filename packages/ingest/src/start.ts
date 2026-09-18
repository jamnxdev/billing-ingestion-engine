import { buildServer } from "./api/server.js";

const DEFAULT_DEDUP_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_BUCKET_SIZE_MS = 60 * 1000;
const DEFAULT_REQUESTS_PER_SECOND = 50;
const DEFAULT_BURST_CAPACITY = 100;
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";

const dedupWindowMs = process.env.DEDUP_WINDOW_MS
  ? Number(process.env.DEDUP_WINDOW_MS)
  : DEFAULT_DEDUP_WINDOW_MS;

const bucketSizeMs = process.env.BUCKET_SIZE_MS
  ? Number(process.env.BUCKET_SIZE_MS)
  : DEFAULT_BUCKET_SIZE_MS;

const requestsPerSecond = process.env.RATE_LIMIT_RPS
  ? Number(process.env.RATE_LIMIT_RPS)
  : DEFAULT_REQUESTS_PER_SECOND;

const burstCapacity = process.env.RATE_LIMIT_BURST
  ? Number(process.env.RATE_LIMIT_BURST)
  : DEFAULT_BURST_CAPACITY;

// API_KEYS_JSON is a JSON object mapping apiKey -> tenantId, e.g.
// '{"sk_live_abc123":"tenant-a","sk_live_def456":"tenant-b"}'. No default —
// an empty map means every request is rejected as unauthenticated, which is
// the correct fail-closed behavior for a misconfigured deployment (silently
// falling back to "no auth required" would be the wrong default to ship).
const apiKeys: Record<string, string> = process.env.API_KEYS_JSON
  ? JSON.parse(process.env.API_KEYS_JSON)
  : {};

const app = buildServer({
  dedupWindowMs,
  bucketSizeMs,
  apiKeys,
  rateLimit: { requestsPerSecond, burstCapacity },
  logger: true,
});

app.listen({ port: PORT, host: HOST }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
