/**
 * A plain Vite dev server for this example: it serves ./index.html (which mounts
 * ./chat.tsx) and hosts the route from ./index.ts at `POST /api/chat`.
 *
 * The middleware below is the whole adapter. A framework (Start, Next, Hono)
 * would do this for you; here it is spelled out, because it is the only thing
 * standing between a connect-style `(req, res)` and the standard `Request` →
 * `Response` handler the example exports:
 *   - the request body is buffered (a small JSON AG-UI envelope) into a `Request`
 *   - the response body is PIPED, chunk by chunk, never buffered — SSE frames
 *     must reach the browser as the run produces them, not after it settles.
 *
 * The handler is loaded through `ssrLoadModule`, so it is transformed by Vite
 * and picks up edits without restarting the server.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/** connect `IncomingMessage` → a standard `Request`. */
async function toRequest(req: IncomingMessage & { originalUrl?: string }): Promise<Request> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) chunks.push(chunk as Uint8Array);

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) for (const item of value) headers.append(key, item);
  }

  const url = new URL(req.originalUrl ?? req.url ?? "/", "http://localhost");
  return new Request(url, {
    method: req.method ?? "GET",
    headers,
    body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
  });
}

/** A standard `Response` → the connect `ServerResponse`, streaming the body. */
async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.flushHeaders();

  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
}

function agentChatApi(): Plugin {
  return {
    name: "agent-chat-api",
    configureServer(server) {
      server.middlewares.use("/api/chat", async (req, res, next) => {
        if (req.method !== "POST") return next();
        try {
          const route = (await server.ssrLoadModule("/index.ts")) as typeof import("./index.js");
          await writeResponse(res, await route.POST({ request: await toRequest(req) }));
        } catch (thrown) {
          // `chatParamsFromRequest` throws a `Response` for a malformed AG-UI
          // body — a real route returns it, so serve it as-is.
          if (thrown instanceof Response) await writeResponse(res, thrown);
          else next(thrown as Error);
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), agentChatApi()],
});
