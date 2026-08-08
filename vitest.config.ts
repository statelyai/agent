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
      { find: "@statelyai/agent/sqlite", replacement: src("sqlite/index.ts") },
      { find: /^@statelyai\/agent$/, replacement: src("index.ts") },
    ],
  },
  test: {
    testTimeout: 10000, // Global timeout of 10000ms for all tests
    // Blanks provider API keys that `dotenv.config()` above pulled in, so the
    // suite can never bill a real provider. Opt in with `LIVE_TESTS=1`.
    setupFiles: [fileURLToPath(new URL("./vitest.setup.ts", import.meta.url))],
    // The demo app has its own vitest config (and `@` alias) — run its tests
    // with `pnpm --dir demo test`. Embedded agent worktrees are other
    // sessions' checkouts — running their copies double-binds test ports.
    exclude: ["**/node_modules/**", "demo/**", "**/.claude/worktrees/**"],
  },
};
