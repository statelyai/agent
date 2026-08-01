import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createApp } from "./index.js";

// `createApp()` resolves real model executors when `OPENAI_API_KEY` is set.
// These tests assert the keyless mock, so the key is neutralized here rather
// than depending on whether the machine running them has one (a repo-root .env
// would otherwise leak in).
beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

/** Hono's whole server contract is `app.fetch`, so the tests call it directly. */
async function post(
  app: ReturnType<typeof createApp>,
  path: string,
  body: unknown,
): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

test("POST /agent settles idle with a draft, and resume APPROVE publishes it", async () => {
  const app = createApp();

  const started = await post(app, "/agent", { topic: "CI speedups" });
  expect(started.status).toBe(202);
  const idle = (await started.json()) as {
    id: string;
    status: string;
    draft: string;
    acceptedEvents: string[];
  };
  expect(idle.status).toBe("idle");
  expect(idle.draft).toContain("Big news:");
  expect(idle.acceptedEvents).toEqual(expect.arrayContaining(["APPROVE", "REJECT"]));

  const resumed = await post(app, `/agent/${idle.id}/resume`, { event: { type: "APPROVE" } });
  expect(resumed.status).toBe(200);
  expect(await resumed.json()).toMatchObject({
    status: "done",
    output: { published: true, draft: idle.draft },
  });
});

test("POST /agent/stream pipes the streamed request into the response body", async () => {
  const response = await post(createApp(), "/agent/stream", { topic: "CI speedups" });

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/plain");
  expect(await response.text()).toBe("Big news: the deploy pipeline just got faster.");
});
