import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { AddressInfo } from "node:net";
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

/** Boots the app on an ephemeral port and returns a `fetch` bound to it. */
async function withServer<T>(
  run: (post: (path: string, body: unknown) => Promise<Response>) => Promise<T>,
): Promise<T> {
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await run((path, body) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("POST /agent settles idle with a draft, and resume APPROVE publishes it", async () => {
  await withServer(async (post) => {
    const started = await post("/agent", { topic: "CI speedups" });
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

    const resumed = await post(`/agent/${idle.id}/resume`, { event: { type: "APPROVE" } });
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({
      status: "done",
      output: { published: true, draft: idle.draft },
    });
  });
});

test("resuming an unknown run id is a 404", async () => {
  await withServer(async (post) => {
    const response = await post("/agent/nope/resume", { event: { type: "APPROVE" } });
    expect(response.status).toBe(404);
  });
});
