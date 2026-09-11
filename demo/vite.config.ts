import { fileURLToPath, URL } from "node:url";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";
import viteTsConfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // Resolve the library to its source, not `dist/`: the package `exports`
      // point at the build, so a stale `dist/` (or none, in a fresh worktree)
      // silently runs old library code under new examples. Subpaths first:
      // the bare alias below would prefix-match them too, and the first
      // matching entry wins.
      ...Object.fromEntries(
        ["ai-sdk", "machines", "openai", "otel"].map((sub) => [
          `@statelyai/agent/${sub}`,
          fileURLToPath(new URL(`../src/${sub}/index.ts`, import.meta.url)),
        ]),
      ),
      "@statelyai/agent": fileURLToPath(new URL("../src/index.ts", import.meta.url)),
    },
  },
  // The examples library lazily imports every `examples/*` module on the
  // server. The `agents` package (cloudflare-agent-host) uses `cloudflare:`
  // protocol imports that esbuild can't optimize — keep it external.
  // `@mastra/core` (mastra-host) pulls execa → npm-run-path, whose browser
  // export of `unicorn-magic` breaks esbuild's dep optimization — external too.
  optimizeDeps: {
    exclude: ["agents", "@mastra/core", "execa", "npm-run-path"],
  },
  ssr: {
    external: ["agents", "@mastra/core", "execa", "npm-run-path"],
  },
  plugins: [
    nitro(),
    viteTsConfigPaths({ projects: ["./tsconfig.json"] }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
});
