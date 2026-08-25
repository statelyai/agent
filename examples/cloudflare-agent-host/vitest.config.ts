import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // `vitest-pool-workers` loads `<configDir>/.dev.vars` as bindings, so
      // once anyone has run `dev:live` a real key would reach the Worker and
      // these tests would silently bill OpenAI. This binding is applied on
      // top of the wrangler/.dev.vars ones, forcing the host keyless: the
      // suite is always scripted.
      miniflare: { bindings: { OPENAI_API_KEY: "" } },
    }),
  ],
  test: {
    // `*.workers-test.ts`, not `*.test.ts`: these specs only run inside workerd
    // (they import `cloudflare:test`), so the name keeps them out of the root
    // Node suite's default glob. Run them with `pnpm test:cloudflare`.
    include: ["test/**/*.workers-test.ts"],
  },
});
