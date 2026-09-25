/**
 * Both ways run against the real `@flue/runtime@2`. Where a test boots the
 * runtime, pi's `fauxProvider` (Flue's own documented test double) plays the
 * conversational model; the machine-owned bridge's model calls go through the
 * repo's mock model (`../mock-model.js`) behind the real AI SDK executors, and
 * its Jev prompt check through a scripted Jev client (`../mock-jev.js`).
 */
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { init } from "@flue/runtime";
import { start as startFlue } from "@flue/runtime/node";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context,
  type FauxResponseFactory,
  type Message,
  type Provider,
} from "@earendil-works/pi-ai";
import { createMockJevClient } from "../mock-jev.js";
import { createMockModelExecutors } from "../mock-model.js";
import {
  completed,
  FlueOwnedAgent,
  flueOwnedMain,
  MachineOwnedAgent,
  main,
  outbox,
  resumeWorkflow,
  startWorkflow,
  useToolExecutors,
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

/** Run `fn` with the named env vars unset, restoring them afterwards. */
async function withoutEnv(keys: string[], fn: () => Promise<void>) {
  const saved = keys.map((key) => [key, process.env[key]] as const);
  for (const key of keys) delete process.env[key];
  try {
    await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// ─── Machine-owned: faux conversational model ───
//
// The factory receives the very `Context` the runtime built for the turn, so
// it reads the last bridge-tool result and answers the choices the machine
// published instead of replaying a fixed script.

type ModelResult = { status: string; handle: string | null; choices: string[]; sentCount: number };

const BRIDGE_TOOLS = new Set(["start_workflow", "resume_workflow"]);
const EVENT_PREFERENCE = ["SEND", "DRAFT_ANYWAY", "END"];

function lastBridgeResult(messages: readonly Message[]): ModelResult | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== "toolResult" || !BRIDGE_TOOLS.has(message.toolName)) continue;
    const text = message.content.find((part) => part.type === "text")?.text;
    return text ? JSON.parse(text) : null;
  }
  return null;
}

function machineOwnedFauxModel(): Provider {
  const respond: FauxResponseFactory = (context: Context) => {
    const result = lastBridgeResult(context.messages);
    if (!result) {
      return fauxAssistantMessage(
        [fauxToolCall("start_workflow", { prompt: "Announce the faster deploys." })],
        { stopReason: "toolUse" },
      );
    }
    if (result.status !== "pending") {
      return fauxAssistantMessage(`Done — ${result.sentCount} email(s) sent.`);
    }
    const accepted = result.choices.map((line) => line.split(" ")[0]!);
    const eventType = EVENT_PREFERENCE.find((type) => accepted.includes(type));
    if (!eventType) throw new Error(`No test answer for pause accepting: ${accepted.join(", ")}`);
    return fauxAssistantMessage(
      [fauxToolCall("resume_workflow", { handle: result.handle, eventType, text: null })],
      { stopReason: "toolUse" },
    );
  };

  const faux = fauxProvider({ provider: "openai", models: [{ id: "gpt-5.4-mini" }] });
  faux.setResponses(Array.from({ length: 10 }, () => respond));
  return faux.provider;
}

// ─── Flue-owned: faux providers driven by what each render offers ───

/** Canned arguments for each workflow tool the agent might offer. */
const CANNED_CALLS: Record<string, Record<string, unknown>> = {
  submit_draft: {
    to: "team@example.com",
    subject: "Deploy pipeline is faster",
    body: "Hi team,\n\nThe deploy pipeline is now roughly twice as fast.\n\nThanks!",
  },
  approve: {},
  send_email: {},
};

/**
 * Faux providers for both models the agent uses, plus the trace of workflow
 * tools each render offered.
 */
function flueOwnedFauxModels(): { providers: Provider[]; trace: string[][] } {
  const trace: string[][] = [];

  const respond: FauxResponseFactory = (context: Context) => {
    const offered = (context.tools ?? [])
      .map((tool) => tool.name)
      .filter((name) => name in CANNED_CALLS);
    trace.push(offered);

    const next = offered[0];
    if (!next) return fauxAssistantMessage("The workflow is complete; the email was sent.");
    return fauxAssistantMessage([fauxToolCall(next, CANNED_CALLS[next]!)], {
      stopReason: "toolUse",
    });
  };

  // One faux provider per provider id the agent names, so `useModel` resolves
  // the same specifiers it would in production.
  const providers = [
    fauxProvider({ provider: "openai", models: [{ id: "gpt-5.4-mini" }] }),
    fauxProvider({ provider: "anthropic", models: [{ id: "claude-sonnet-5" }] }),
  ].map((faux) => {
    faux.setResponses(Array.from({ length: 12 }, () => respond));
    return faux.provider;
  });

  return { providers, trace };
}

describe("flue-host (machine-owned)", () => {
  beforeAll(() => {
    useToolExecutors(
      createMockModelExecutors({
        text: {
          draftEmail: {
            to: "team@example.com",
            subject: "Deploy pipeline is faster",
            body: "Hi team,\n\nThe deploy pipeline is now roughly twice as fast.\n\nThanks!",
          },
        },
      }),
      // Every request is judged complete, so the run drafts straight away.
      createMockJevClient({ "*": true }).client,
    );
  });

  test("start_workflow drafts and pauses for review", async () => {
    const result = await start("Tell the team the deploy pipeline is twice as fast.");

    expect(result.status).toBe("pending");
    expect(result.handle).toMatch(/^draft-\d+$/);
    // The machine drove itself past the prompt and both model calls to the
    // human review pause; the host never named a state to get there.
    expect(result.label).toContain("Send the draft");
    expect(result.choices).toContain("SEND (Send email)");
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

  test("revision text is delivered through the interaction's declared textEvent", async () => {
    const started = await start("Announce the faster deploys.");

    // REQUEST_CHANGES is the reviewing pause's `textEvent`, so the host attaches
    // the typed text to it without hardcoding the event's payload shape.
    const revised = await resume(started.handle!, "REQUEST_CHANGES", "Make it shorter.");
    expect(revised.status).toBe("pending");
    expect(revised.label).toContain("Send the draft");
    expect(revised.draft).toContain("Deploy pipeline is faster");
  });

  test("an event the state does not handle is ignored", async () => {
    const started = await start("Announce the faster deploys.");

    // `SEND` is handled at `reviewing`, not after the email has already been
    // sent: the machine ignores the second one and the bridge reports it.
    await resume(started.handle!, "SEND");
    await expect(resume(started.handle!, "SEND")).rejects.toThrow(/'SEND' does not apply/);
  });

  test("an unknown handle is rejected", async () => {
    await expect(resume("draft-nope", "SEND")).rejects.toThrow(/Unknown handle/);
  });

  test("the agent drives the workflow end to end on the real Flue runtime", async () => {
    completed.length = 0;
    const flue = await startFlue({
      agents: [MachineOwnedAgent],
      providers: [machineOwnedFauxModel()],
    });
    try {
      const agent = init(MachineOwnedAgent, { id: "machine-owned-test" });
      await agent.read(await agent.dispatch("Announce the faster deploys."));
    } finally {
      await flue.stop();
    }
    // The machine reached `done` and reported exactly one sent email.
    expect(completed).toHaveLength(1);
    expect(completed[0]).toHaveLength(1);
  });

  test("the demo requires OPENAI_API_KEY", async () => {
    await withoutEnv(["OPENAI_API_KEY"], async () => {
      await expect(main()).rejects.toThrow("OPENAI_API_KEY");
    });
  });
});

describe("flue-host (flue-owned)", () => {
  beforeEach(() => {
    outbox.length = 0;
  });

  test("the workflow advances one step per model turn, and each step re-tools", async () => {
    const scripted = flueOwnedFauxModels();
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

  test("the demo requires both OPENAI_API_KEY and ANTHROPIC_API_KEY", async () => {
    await withoutEnv(["OPENAI_API_KEY", "ANTHROPIC_API_KEY"], async () => {
      await expect(flueOwnedMain()).rejects.toThrow("OPENAI_API_KEY");
      process.env.OPENAI_API_KEY = "sk-test";
      await expect(flueOwnedMain()).rejects.toThrow("ANTHROPIC_API_KEY");
    });
  });
});
