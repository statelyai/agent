import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "ai-sdk": "src/ai-sdk/index.ts",
    log: "src/log/index.ts",
    machines: "src/machines/index.ts",
    openai: "src/openai/index.ts",
    otel: "src/otel/index.ts",
    testing: "src/testing/index.ts",
    validate: "src/validate/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
});
