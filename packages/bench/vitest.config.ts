import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      "@billing/aggregator": fileURLToPath(
        new URL("../aggregator/src/index.ts", import.meta.url),
      ),
      "@billing/ingest": fileURLToPath(new URL("../ingest/src/index.ts", import.meta.url)),
      "@billing/testclient": fileURLToPath(
        new URL("../testclient/src/index.ts", import.meta.url),
      ),
    },
  },
});
