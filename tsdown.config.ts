import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "ai-sdk": "src/ai-sdk/index.ts",
    evals: "src/evals/index.ts",
    log: "src/log/index.ts",
    openai: "src/openai/index.ts",
    otel: "src/otel/index.ts",
    "tanstack-ai": "src/tanstack-ai/index.ts",
    testing: "src/testing/index.ts",
    validate: "src/validate/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  // JSDoc stays in the .d.mts/.d.cts files. In the .mjs/.cjs files, a JSDoc
  // example with `vi.mock(` makes Vitest 4 hoist the module as a mock file
  // under the Cloudflare pool, and its re-exports then read `undefined`.
  outputOptions: { comments: { jsdoc: false } },
});
