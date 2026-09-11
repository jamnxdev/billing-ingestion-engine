import { buildServer } from "./api/server.js";

const DEFAULT_DEDUP_WINDOW_MS = 5 * 60 * 1000;
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";

const dedupWindowMs = process.env.DEDUP_WINDOW_MS
  ? Number(process.env.DEDUP_WINDOW_MS)
  : DEFAULT_DEDUP_WINDOW_MS;

const app = buildServer({ dedupWindowMs, logger: true });

app
  .listen({ port: PORT, host: HOST })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
