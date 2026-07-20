/**
 * MINIMAL LOCAL SHIMS for the web `Request`/`Response` a Next.js route handler
 * receives and returns. This repo does not depend on Next, so these keep the
 * example typechecking standalone. In a real Next app you DELETE this file:
 * `Request`/`Response` are global (typed by `lib.dom`/undici) and you'd return
 * `NextResponse.json(...)` from `next/server` instead of the `json()` helper.
 */

/** The subset of the web `Request` the handlers read. */
export interface RouteRequest {
  json(): Promise<unknown>;
}

/** Stand-in for the web `Response` a route handler returns. */
export interface RouteResponse {
  readonly status: number;
  readonly body: unknown;
}

/** Stand-in for `NextResponse.json(data, init)` / `Response.json(...)`. */
export function json(data: unknown, init: { status?: number } = {}): RouteResponse {
  return { status: init.status ?? 200, body: data };
}
