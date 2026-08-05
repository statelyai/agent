import { beforeEach, describe, expect, test } from "vitest";
import { AgentIllegalResumeEventError } from "@statelyai/agent";
import { init } from "@flue/runtime";
import { start as startFlue } from "@flue/runtime/node";
import {
  completed,
  FlueOwnedAgent,
  flueOwnedMain,
  flueOwnedScriptedModel,
  main,
  outbox,
  resumeWorkflow,
  startWorkflow,
} from "./index.js";

/**
 * What Flue's tool loop supplies around the arguments. These tools read only
 * `data`, so the rest are inert stand-ins — enough to exercise a tool directly,
 * without booting a runtime.
 */
const toolContext = {
  toolCallId: "test-call",
  log: { info() {}, warn() {}, error() {} },
};

const start = async (prompt: string) =>
  (await startWorkflow.run({ ...toolContext, data: { prompt } })).output;

const resume = async (handle: string, eventType: string, text: string | null = null) =>
  (await resumeWorkflow.run({ ...toolContext, data: { handle, eventType, text } })).output;

describe("flue-host (machine-owned)", () => {
  test("start_workflow drafts and pauses for review", async () => {
    const result = await start("Tell the team the deploy pipeline is twice as fast.");

    expect(result.status).toBe("pending");
    expect(result.handle).toMatch(/^draft-\d+$/);
    // The machine drove itself past the prompt and both model calls to the
    // human review pause; the host never named a state to get there.
    expect(result.label).toContain("Send the draft");
    expect(result.choices).toContain("SEND (Send)");
    expect(result.draft).toContain("Deploy pipeline is faster");
  });

  test("resume_workflow sends, then finishes with the sent email", async () => {
    const started = await start("Announce the faster deploys.");

    const sent = await resume(started.handle!, "SEND");
    expect(sent.status).toBe("pending");
    expect(sent.label).toContain("Draft another one?");

    const finished = await resume(started.handle!, "END");
    expect(finished.status).toBe("done");
    expect(finished.sentCount).toBe(1);
  });

  test("revision text is routed to the field the interaction declared", async () => {
    const started = await start("Announce the faster deploys.");

    // REQUEST_CHANGES declares an input field (`changes`); the host derives that
    // from `meta.interaction` rather than hardcoding the event's payload shape.
    const revised = await resume(started.handle!, "REQUEST_CHANGES", "Make it shorter.");
    expect(revised.status).toBe("pending");
    expect(revised.label).toContain("Send the draft");
    expect(revised.draft).toContain("Deploy pipeline is faster");
  });

  test("the machine refuses an illegal resume", async () => {
    const started = await start("Announce the faster deploys.");

    // `SEND` is legal at `reviewing`, not after the email has already been sent.
    await resume(started.handle!, "SEND");
    await expect(resume(started.handle!, "SEND")).rejects.toBeInstanceOf(
      AgentIllegalResumeEventError,
    );
  });

  test("an unknown handle is rejected", async () => {
    await expect(resume("draft-nope", "SEND")).rejects.toThrow(/Unknown handle/);
  });

  test("the demo runs the real Flue runtime end to end with no API key", async () => {
    await expect(main()).resolves.toBeUndefined();
    // The machine reached `done` and reported exactly one sent email.
    expect(completed).toHaveLength(1);
    expect(completed[0]).toHaveLength(1);
  });
});

describe("flue-host (flue-owned)", () => {
  beforeEach(() => {
    outbox.length = 0;
  });

  test("the workflow advances one step per model turn, and each step re-tools", async () => {
    const scripted = flueOwnedScriptedModel();
    const flue = await startFlue({ agents: [FlueOwnedAgent], providers: scripted.providers });
    try {
      const agent = init(FlueOwnedAgent, { id: "flue-owned-test" });
      await agent.read(await agent.dispatch("Announce the faster deploys, then send it."));
    } finally {
      await flue.stop();
    }

    // The whole point of the pattern: the tools the agent has change with the
    // step, and the step can only move along a declared transition.
    expect(scripted.trace).toEqual([["submit_draft"], ["approve"], ["send_email"], []]);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.subject).toBe("Deploy pipeline is faster");
  });

  test("the demo runs end to end with no API key", async () => {
    await expect(flueOwnedMain()).resolves.toBeUndefined();
    expect(outbox).toHaveLength(1);
  });
});
