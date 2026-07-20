// vitest.config.ts
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
dotenv.config();

const src = (p: string) => fileURLToPath(new URL(`./src/${p}`, import.meta.url));

export default {
  resolve: {
    // Exact-match aliases so examples can import the package by name and
    // still resolve to `src/` (not `dist/`). Subpaths are listed before the
    // bare name, and the bare name uses an exact-match regex so it never
    // clobbers the subpath imports.
    alias: [
      { find: "@statelyai/agent/ai-sdk", replacement: src("ai-sdk/index.ts") },
      {
        find: "@statelyai/agent/openai-compat",
        replacement: src("openai-compat/index.ts"),
      },
      { find: "@statelyai/agent/steps", replacement: src("steps/index.ts") },
      { find: "@statelyai/agent/adapter", replacement: src("adapter/index.ts") },
      { find: "@statelyai/agent/zod", replacement: src("zod/index.ts") },
      { find: /^@statelyai\/agent$/, replacement: src("index.ts") },
    ],
  },
  test: {
    testTimeout: 10000, // Global timeout of 10000ms for all tests
  },
};
