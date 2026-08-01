import { describe, expect, test } from "vitest";
import { noopObserve } from "@mastra/core/tools";
import { AgentIllegalResumeEventError } from "@statelyai/agent";
import {
  emailHostAgent,
  main,
  resumeDraft,
  resumeWorkflow,
  startDraft,
  startWorkflow,
  unwrapToolResult,
} from "./index.js";

const ctx = { observe: noopObserve };

/** Call a tool the way Mastra's tool loop would, then narrow the widened return. */
const start = async (prompt: string) =>
  unwrapToolResult(await startWorkflow.execute!({ prompt }, ctx));

const resume = async (handle: string, eventType: string, text: string | null = null) =>
  unwrapToolResult(await resumeWorkflow.execute!({ handle, eventType, text }, ctx));

describe("mastra-host", () => {
  test("start_workflow drafts and pauses for review", async () => {
    const result = await start("Tell the team the deploy pipeline is twice as fast.");

    expect(result.status).toBe("pending");
    if (result.status !== "pending") return;
    expect(result.handle).toMatch(/^draft-\d+$/);
    // The machine drove itself past the prompt and both model calls to the
    // human review pause; the host never named a state to get there.
    expect(result.draft?.subject).toBe("Deploy pipeline is faster");
    expect(result.interaction?.type).toBe("select");
  });

  test("resume_workflow sends, then finishes with the sent email", async () => {
    const started = await start("Announce the faster deploys.");
    if (started.status !== "pending") throw new Error("expected pending");

    const sent = await resume(started.handle, "SEND");
    expect(sent.status).toBe("pending");
    if (sent.status !== "pending") return;
    expect(sent.interaction?.type).toBe("confirm");

    const finished = await resume(started.handle, "END");
    expect(finished.status).toBe("done");
    if (finished.status !== "done") return;
    expect(finished.sentEmails).toHaveLength(1);
    expect(finished.sentEmails[0]?.to).toBe("team@example.com");
  });

  test("revision text is routed to the field the interaction declared", async () => {
    const started = await startDraft("Announce the faster deploys.");
    if (started.status !== "pending") throw new Error("expected pending");

    // REQUEST_CHANGES declares an input field (`changes`); the host derives that
    // from `meta.interaction` rather than hardcoding the event's payload shape.
    const revised = await resumeDraft(started.handle, "REQUEST_CHANGES", "Make it shorter.");
    expect(revised.status).toBe("pending");
    if (revised.status !== "pending") return;
    expect(revised.interaction?.type).toBe("select");
    expect(revised.draft).not.toBeNull();
  });

  test("the machine refuses an illegal resume", async () => {
    const started = await startDraft("Announce the faster deploys.");
    if (started.status !== "pending") throw new Error("expected pending");

    // `SEND` is legal at `reviewing`, not after the email has already been sent.
    await resumeDraft(started.handle, "SEND");
    await expect(resumeDraft(started.handle, "SEND")).rejects.toBeInstanceOf(
      AgentIllegalResumeEventError,
    );
  });

  test("an unknown handle is rejected", async () => {
    await expect(resumeDraft("draft-nope", "SEND")).rejects.toThrow(/Unknown handle/);
  });

  test("the Mastra agent exposes both bridge tools under their model-facing names", async () => {
    const tools = await emailHostAgent.listTools();
    expect(Object.keys(tools).sort()).toEqual(["resume_workflow", "start_workflow"]);
  });

  test("the demo runs end to end with no API key", async () => {
    await expect(main()).resolves.toBeUndefined();
  });
});
