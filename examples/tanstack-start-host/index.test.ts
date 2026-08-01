/**
 * The Start app's agent logic, tested without a server.
 *
 * The server functions in ./index.ts are thin: validate, `runAgent`, persist.
 * What is worth pinning is the seam underneath them — the machine's
 * draft → review → publish cycle across a persisted snapshot, and the wire
 * schema derived from the same event map the machine is built from.
 *
 * The HTTP half is covered by booting the app (`pnpm --dir examples/tanstack-start-host dev`).
 */
import { describe, expect, it } from "vitest";
import { createScriptedExecutors, persistSnapshot, runAgent } from "@statelyai/agent";
import { announceEventSchema, announceMachine } from "./index.js";

const drafts = (...texts: string[]) => createScriptedExecutors({ text: texts });

describe("announceEventSchema", () => {
  it("accepts the machine's events", () => {
    expect(announceEventSchema.parse({ type: "APPROVE" })).toEqual({ type: "APPROVE" });
    expect(announceEventSchema.parse({ type: "REJECT", reason: "too vague" })).toEqual({
      type: "REJECT",
      reason: "too vague",
    });
  });

  it("rejects an unknown type and a REJECT with no reason", () => {
    expect(() => announceEventSchema.parse({ type: "PUBLISH" })).toThrow();
    expect(() => announceEventSchema.parse({ type: "REJECT" })).toThrow();
  });
});

describe("announceMachine", () => {
  it("drafts, then idles for review", async () => {
    const result = await runAgent(announceMachine, {
      input: { topic: "the deploy pipeline" },
      executors: drafts("first draft"),
    });

    expect(result.status).toBe("idle");
    if (result.status !== "idle") return;
    expect(result.snapshot.context.draft).toBe("first draft");
  });

  it("publishes when the persisted snapshot is resumed with APPROVE", async () => {
    const idle = await runAgent(announceMachine, {
      input: { topic: "the deploy pipeline" },
      executors: drafts("first draft"),
    });
    expect(idle.status).toBe("idle");
    if (idle.status !== "idle") return;

    const done = await runAgent(announceMachine, {
      snapshot: persistSnapshot(idle.snapshot),
      event: { type: "APPROVE" },
      executors: drafts(),
    });

    expect(done.status).toBe("done");
    if (done.status !== "done") return;
    expect(done.output).toEqual({ published: true, draft: "first draft" });
  });

  it("redrafts with the reason in the topic when REJECTed", async () => {
    const idle = await runAgent(announceMachine, {
      input: { topic: "the deploy pipeline" },
      executors: drafts("first draft"),
    });
    if (idle.status !== "idle") throw new Error(`expected idle, got ${idle.status}`);

    let seenPrompt = "";
    const rejected = await runAgent(announceMachine, {
      snapshot: persistSnapshot(idle.snapshot),
      event: { type: "REJECT", reason: "name the speedup" },
      executors: createScriptedExecutors({
        text: [
          (request) => {
            seenPrompt = request.prompt ?? "";
            return "second draft";
          },
        ],
      }),
    });

    expect(seenPrompt).toContain("Revision requested: name the speedup");
    expect(rejected.status).toBe("idle");
    if (rejected.status !== "idle") return;
    expect(rejected.snapshot.context.draft).toBe("second draft");
  });
});
