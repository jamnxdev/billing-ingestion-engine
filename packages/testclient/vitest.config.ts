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
    },
  },
});
