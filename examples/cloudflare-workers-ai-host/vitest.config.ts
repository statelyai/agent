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
      },
    },
  },
});
