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
  optimizeDeps: {
    exclude: ["agents"],
  },
  ssr: {
    external: ["agents"],
  },
  plugins: [
    nitro(),
    viteTsConfigPaths({ projects: ["./tsconfig.json"] }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
});
