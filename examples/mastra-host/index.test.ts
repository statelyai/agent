import { describe, expect, test } from "vitest";
import { noopObserve } from "@mastra/core/tools";
import type { AgentRequestExecutors } from "@statelyai/agent";
import { createHost, scriptedExecutors, main, unwrapToolResult } from "./index.js";

const ctx = { observe: noopObserve };

/** A fresh host per test: no run, handle, or executor is shared between them. */
function host() {
  const { startWorkflow, resumeWorkflow, startDraft, resumeDraft, agent } = createHost({
    executors: scriptedExecutors,
  });
  return {
    agent,
    startDraft,
    resumeDraft,
    /** Call a tool the way Mastra's tool loop would, then narrow the widened return. */
    start: async (prompt: string) =>
      unwrapToolResult(await startWorkflow.execute!({ prompt }, ctx)),
    resume: async (handle: string, eventType: string, text: string | null = null) =>
      unwrapToolResult(await resumeWorkflow.execute!({ handle, eventType, text }, ctx)),
  };
}

describe("mastra-host", () => {
  test("start_workflow drafts and pauses for review", async () => {
    const result = await host().start("Tell the team the deploy pipeline is twice as fast.");

    expect(result.status).toBe("pending");
    if (result.status !== "pending") return;
    expect(result.handle).toMatch(/^draft-\d+$/);
    // The machine drove itself past the prompt and both model calls to the
    // human review pause; the host never named a state to get there.
    expect(result.draft?.subject).toBe("Deploy pipeline is faster");
    expect(result.interaction?.events.map(({ type }) => type)).toEqual(["SEND", "REQUEST_CHANGES"]);
    expect(result.interaction?.textEvent).toBe("REQUEST_CHANGES");
  });

  test("resume_workflow sends, then finishes with the sent email", async () => {
    const { start, resume } = host();
    const started = await start("Announce the faster deploys.");
    if (started.status !== "pending") throw new Error("expected pending");

    const sent = await resume(started.handle, "SEND");
    expect(sent.status).toBe("pending");
    if (sent.status !== "pending") return;
    expect(sent.interaction?.events.map(({ type }) => type)).toEqual(["ANOTHER", "END"]);

    const finished = await resume(started.handle, "END");
    expect(finished.status).toBe("done");
    if (finished.status !== "done") return;
    expect(finished.sentEmails).toHaveLength(1);
    expect(finished.sentEmails[0]?.to).toBe("team@example.com");
  });

  test("revision text is routed to the event the interaction declared as its textEvent", async () => {
    const { startDraft, resumeDraft } = host();
    const started = await startDraft("Announce the faster deploys.");
    if (started.status !== "pending") throw new Error("expected pending");

    // The host reads `textEvent` off the rendered interaction rather than
    // hardcoding REQUEST_CHANGES's payload shape.
    const revised = await resumeDraft(started.handle, "REQUEST_CHANGES", "Make it shorter.");
    expect(revised.status).toBe("pending");
    if (revised.status !== "pending") return;
    expect(revised.draft).not.toBeNull();
    expect(revised.interaction?.events.map(({ type }) => type)).toContain("SEND");
  });

  test("an event the state does not handle is ignored", async () => {
    const { startDraft, resumeDraft } = host();
    const started = await startDraft("Announce the faster deploys.");
    if (started.status !== "pending") throw new Error("expected pending");

    // `SEND` is handled at `reviewing`, not after the email has already been
    // sent: the machine ignores the second one and the host reports it.
    await resumeDraft(started.handle, "SEND");
    expect(await resumeDraft(started.handle, "SEND")).toEqual({
      status: "error",
      error: "'SEND' does not apply in the current state.",
    });
  });

  test("an unknown handle comes back as a tool error, not an exception", async () => {
    const result = await host().resumeDraft("draft-nope", "SEND");
    expect(result).toEqual({
      status: "error",
      error: "Unknown handle: draft-nope. Start a new workflow.",
    });
  });

  test("two hosts never share a run store", async () => {
    const first = host();
    const started = await first.startDraft("Announce the faster deploys.");
    if (started.status !== "pending") throw new Error("expected pending");

    const second = host();
    const result = await second.resumeDraft(started.handle, "SEND");
    expect(result.status).toBe("error");
  });

  test("the injected executors are the ones the tools run with", async () => {
    const markerExecutors: AgentRequestExecutors = {
      generateText: async (request) =>
        request.name === "evaluatePrompt"
          ? { output: { satisfied: true, missing: [], questions: [] } }
          : {
              output: {
                to: "marker@example.com",
                subject: "MARKER SUBJECT",
                body: "Written by the marker executor.",
              },
            },
    };
    const { startDraft } = createHost({ executors: markerExecutors });

    const started = await startDraft("Announce the faster deploys.");
    expect(started.status).toBe("pending");
    if (started.status !== "pending") return;
    expect(started.draft?.subject).toBe("MARKER SUBJECT");
  });

  test("the Mastra agent exposes both bridge tools under their model-facing names", async () => {
    const tools = await host().agent.listTools();
    expect(Object.keys(tools).sort()).toEqual(["resume_workflow", "start_workflow"]);
  });

  test("the demo runs end to end with no API key", async () => {
    await expect(main()).resolves.toBeUndefined();
  });
});
