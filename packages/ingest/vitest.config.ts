import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      // Tests run against the aggregator's TS source directly, not its
      // built dist/ output, so `npm test` never needs a prior cross-package
      // build step — `npm run build` (which does resolve via node_modules,
      // and therefore does need dist/ present) is what proves the published
      // artifact actually works end to end.
      "@billing/aggregator": fileURLToPath(
        new URL("../aggregator/src/index.ts", import.meta.url),
      ),
    },
  },
});
