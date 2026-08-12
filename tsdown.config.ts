import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "ai-sdk": "src/ai-sdk/index.ts",
    machines: "src/machines/index.ts",
    otel: "src/otel/index.ts",
    sqlite: "src/sqlite/index.ts",
    validate: "src/validate/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
});
