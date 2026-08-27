import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      // test/wrangler.jsonc, not ./wrangler.jsonc: the deploy config's `ai`
      // binding would make wrangler open a remote proxy session (login
      // required), and the specs stub `env.AI` anyway.
      wrangler: { configPath: "./test/wrangler.jsonc" },
    }),
  ],
  test: {
    // `*.workers-test.ts`, not `*.test.ts`: these specs only run inside workerd
    // (they import `cloudflare:test`), so the name keeps them out of the root
    // Node suite's default glob. Run them with `pnpm test:cloudflare`.
    include: ["test/**/*.workers-test.ts"],
  },
});
