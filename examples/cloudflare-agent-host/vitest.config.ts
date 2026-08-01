import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    // `*.workers-test.ts`, not `*.test.ts`: these specs only run inside workerd
    // (they import `cloudflare:test`), so the name keeps them out of the root
    // Node suite's default glob. Run them with `pnpm test:cloudflare`.
    include: ["test/**/*.workers-test.ts"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
        // `vitest-pool-workers` loads `<configDir>/.dev.vars` as bindings, so
        // once anyone has run `dev:live` a real key would reach the Worker and
        // these tests would silently bill OpenAI. This binding is applied on
        // top of the wrangler/.dev.vars ones, forcing the host keyless: the
        // suite is always scripted.
        miniflare: { bindings: { OPENAI_API_KEY: "" } },
        // Every test file gets its own Durable Object storage.
        isolatedStorage: true,
      },
    },
  },
});
