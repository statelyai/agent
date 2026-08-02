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
