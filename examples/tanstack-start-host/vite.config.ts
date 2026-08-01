/**
 * A real TanStack Start app: `tanstackStart()` supplies the client/server
 * entries, the file-route scanner and the server-function RPC endpoint
 * (`/_serverFn/<id>`) that the server functions in ./index.ts are served from.
 *
 * `srcDirectory` is `src` (the default), so routes live in `src/routes` and the
 * plugin regenerates `src/routeTree.gen.ts` on boot.
 */
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  server: { port: 3008 },
  plugins: [tanstackStart(), viteReact()],
});
