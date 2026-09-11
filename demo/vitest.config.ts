import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // Same as vite.config.ts: test the library's source, never a stale dist/.
      ...Object.fromEntries(
        ["ai-sdk", "machines", "openai", "otel"].map((sub) => [
          `@statelyai/agent/${sub}`,
          fileURLToPath(new URL(`../src/${sub}/index.ts`, import.meta.url)),
        ]),
      ),
      "@statelyai/agent": fileURLToPath(new URL("../src/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
  },
});
