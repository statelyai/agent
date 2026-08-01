/**
 * Way 1 — THE MACHINE OWNS THE LOGIC.
 *
 * The email-draft machine from ../email-drafter owns the workflow: its own
 * model calls (evaluate, draft), its branches (needs-more-info), its pauses
 * (`meta.interaction`), and legality. The Flue 2 agent is a conversational
 * shell with two bridge tools:
 *
 *   - `start_workflow` runs `runAgent(emailDrafter, ...)` to its first idle,
 *     delivers the user's request, persists the snapshot, and returns a handle
 *     plus the draft and the choice to present.
 *   - `resume_workflow` reloads that snapshot and delivers the human's event.
 *
 * Nothing here hardcodes a state name; the event to send is derived from the
 * machine's own `meta.interaction`, so adding a state to the machine needs no
 * host change. Illegal resumes are refused by `runAgent` itself
 * (AgentIllegalResumeEventError), so no hand-rolled legality check lives in
 * the tools.
 *
 * Because the machine owns everything, the agent body needs no persistent
 * state and no branching: every render attaches the same model and the same
 * two tools. Contrast ./flue-owned.ts, where Flue's hooks do the owning.
 *
 * Snapshots live in an in-memory `Map` keyed by handle (same shape as
 * examples/express-host); swap it for Redis/Postgres and the tools are
 * unchanged.
 *
 * Run: npx tsx examples/flue-host/index.ts
 *   No API key -> pi's faux provider plays the model and keyless mock executors
 *     drive the machine end to end.
 *   OPENAI_API_KEY=... -> a real model calls the same two tools, and the
 *     machine runs against real generations.
 */
import assert from "node:assert/strict";
import type { z } from "zod";
import type { EventFromLogic, Snapshot } from "xstate";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import {
  getStateMeta,
  persistSnapshot,
  runAgent,
  type AgentTextRequest,
  type RunAgentOptions,
  type RunAgentResult,
} from "@statelyai/agent";
import {
  emailDrafter,
  emailDrafterSchemas,
  metaSchema,
  models,
} from "../email-drafter/agent-logic.js";
import * as v from "valibot";
import { defineTool, init, useModel, useTool } from "@flue/runtime";
import { start } from "@flue/runtime/node";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context,
  type FauxResponseFactory,
  type Message,
} from "@earendil-works/pi-ai";

// ─── Shared shapes ───

type EmailDraft = z.infer<typeof emailDrafterSchemas.output>["sentEmails"][number];

/**
 * The machine's own interaction protocol. The host never redeclares what a
 * pause looks like: `metaSchema` from the email-drafter IS the contract.
 */
const interactionSchema = metaSchema.shape.interaction.unwrap();
type Interaction = z.infer<typeof interactionSchema>;

export type ToolResult =
  | {
      status: "pending";
      handle: string;
      interaction: Interaction | null;
      draft: EmailDraft | null;
      sentCount: number;
    }
  | { status: "done"; sentEmails: EmailDraft[] };

// ─── Snapshot store ───
//
// What the host persists between tool calls. The stored `interaction` is what
// lets `resume_workflow` map an eventType back to its payload field generically.

interface StoredRun {
  snapshot: Snapshot<unknown>;
  interaction: Interaction | null;
}

const runs = new Map<string, StoredRun>();

/**
 * Every workflow that reached `done`, in completion order. The machine — not
 * the model's prose — is the source of truth for what actually happened, so
 * this is what the demo and its tests assert on.
 */
export const completed: EmailDraft[][] = [];

// ─── Keyless executors ───

/**
 * Mock executors so the example (and its test) run with no API key or network.
 * Routes on `request.model` (the model ref each request declared in
 * ../email-drafter) instead of sniffing prompt text.
 */
export const mockRunOptions: RunAgentOptions<typeof emailDrafter> = {
  executors: {
    generateText: async (request: AgentTextRequest) =>
      request.model === "promptEvaluator"
        ? { output: { satisfied: true, missing: [], questions: [] } }
        : {
            output: {
              to: "team@example.com",
              subject: "Deploy pipeline is faster",
              body: "Hi team,\n\nThe deploy pipeline is now roughly twice as fast.\n\nThanks!",
            },
          },
  },
};

/**
 * What the tools actually run with. Defaults to the keyless mock so importing
 * this module never touches the network; `useLiveExecutors()` swaps in real
 * generations through the email-drafter's declared models.
 */
let toolRunOptions: RunAgentOptions<typeof emailDrafter> = mockRunOptions;

export function useLiveExecutors() {
  toolRunOptions = { executors: createAiSdkExecutors({ models }) };
}

// ─── Bridge: runAgent <-> JSON-safe tool results ───

/**
 * Which context field an event's payload goes in, read off the interaction the
 * machine just published. Generic: no event or state name is hardcoded.
 */
function payloadFieldFor(interaction: Interaction | null, eventType: string): string | null {
  if (!interaction) return null;
  switch (interaction.type) {
    case "text":
      return interaction.eventType === eventType ? interaction.field : null;
    case "select":
      return (
        interaction.choices.find((choice) => choice.eventType === eventType)?.input?.field ?? null
      );
    case "confirm":
      return null;
  }
}

/**
 * Build the machine event for `eventType`, attaching `text` to whichever field
 * the interaction says it belongs in. The cast is the one unavoidable seam: the
 * eventType arrives as a model-supplied string, so there is nothing static to
 * infer from — unlike ./flue-owned.ts, where events are code-authored and
 * `EventFromLogic` types them for free. `runAgent` still validates the event
 * against the restored state and throws on anything illegal.
 */
function buildEvent(
  interaction: Interaction | null,
  eventType: string,
  text: string | null,
): EventFromLogic<typeof emailDrafter> {
  const field = payloadFieldFor(interaction, eventType);
  const event = field && text !== null ? { type: eventType, [field]: text } : { type: eventType };
  return event as EventFromLogic<typeof emailDrafter>;
}

let nextHandle = 0;

/** Fold a run result into a JSON-safe tool result, persisting on every pause. */
function toToolResult(result: RunAgentResult<typeof emailDrafter>, handle: string): ToolResult {
  if (result.status === "error") throw result.error;
  if (result.status === "done") {
    runs.delete(handle);
    completed.push(result.output.sentEmails);
    return { status: "done", sentEmails: result.output.sentEmails };
  }

  const meta = getStateMeta<typeof result.snapshot, z.infer<typeof metaSchema>>(result.snapshot);
  const interaction = meta.interaction ?? null;
  runs.set(handle, { snapshot: persistSnapshot(result.snapshot), interaction });

  return {
    status: "pending",
    handle,
    interaction,
    draft: result.snapshot.context.draft,
    sentCount: result.snapshot.context.sentEmails.length,
  };
}

/**
 * Bridge #1: start the machine, hand it the user's request, run to the first
 * pause. The machine opens on a `text` interaction, so the request is delivered
 * through that interaction's own eventType/field rather than a literal
 * `PROMPT_SUBMITTED`.
 */
export async function startDraft(
  prompt: string,
  // Defaults evaluate per call, so `useLiveExecutors()` takes effect for
  // direct callers too (mirrors eve-host/bridge.ts and mastra-host).
  runOptions: RunAgentOptions<typeof emailDrafter> = toolRunOptions,
): Promise<ToolResult> {
  const handle = `draft-${++nextHandle}`;
  const opened = await runAgent(emailDrafter, { ...runOptions, input: undefined });
  const pending = toToolResult(opened, handle);
  if (pending.status === "done") return pending;

  return resumeDraft(
    handle,
    pending.interaction?.type === "text" ? pending.interaction.eventType : "PROMPT_SUBMITTED",
    prompt,
    runOptions,
  );
}

/** Bridge #2: reload the persisted snapshot, deliver the event, run to the next pause. */
export async function resumeDraft(
  handle: string,
  eventType: string,
  text: string | null = null,
  runOptions: RunAgentOptions<typeof emailDrafter> = toolRunOptions,
): Promise<ToolResult> {
  const stored = runs.get(handle);
  if (!stored) throw new Error(`Unknown handle: ${handle}`);

  const result = await runAgent(emailDrafter, {
    ...runOptions,
    snapshot: stored.snapshot,
    event: buildEvent(stored.interaction, eventType, text),
  });
  return toToolResult(result, handle);
}

// ─── Model-facing projection ───
//
// Flue JSON-stringifies structured output for the model, and the Valibot schema
// is what the model is shown, so the rich `Interaction` union is flattened here
// into plain strings. The bridge above keeps the typed interaction so
// `resume_workflow` can still derive an event's payload field from it.

const resultSchema = v.object({
  status: v.string(),
  handle: v.nullable(v.string()),
  label: v.nullable(v.string()),
  choices: v.array(v.string()),
  draft: v.nullable(v.string()),
  sentCount: v.number(),
});

/** One line per resumable event: its eventType, its label, and whether it takes text. */
function choiceLines(interaction: Interaction | null): string[] {
  if (!interaction) return [];
  switch (interaction.type) {
    case "text":
      return [`${interaction.eventType} (${interaction.label}, needs text)`];
    case "select":
      return interaction.choices.map(
        (choice) => `${choice.eventType} (${choice.label}${choice.input ? ", needs text" : ""})`,
      );
    case "confirm":
      return [`${interaction.trueEventType} (yes)`, `${interaction.falseEventType} (no)`];
  }
}

/** Project a ToolResult into the flat shape declared by `resultSchema`. */
function toModelResult(result: ToolResult) {
  return result.status === "pending"
    ? {
        status: "pending" as const,
        handle: result.handle,
        label: result.interaction?.label ?? null,
        choices: choiceLines(result.interaction),
        draft: result.draft
          ? `To: ${result.draft.to}\nSubject: ${result.draft.subject}\n\n${result.draft.body}`
          : null,
        sentCount: result.sentCount,
      }
    : {
        status: "done" as const,
        handle: null,
        label: null,
        choices: [],
        draft: null,
        sentCount: result.sentEmails.length,
      };
}

// ─── The Flue tools ───

/** Tool #1: start the machine on the user's request, run to the review pause. */
export const startWorkflow = defineTool({
  name: "start_workflow",
  description:
    "Start an email-drafting workflow from the user's request. Returns status " +
    "'pending' with a handle, the current draft, and the choices to present, or " +
    "'done' with how many emails were sent.",
  input: v.object({
    prompt: v.pipe(v.string(), v.description("The user's email request, in their own words")),
  }),
  output: resultSchema,
  async run({ data }) {
    return { output: toModelResult(await startDraft(data.prompt, toolRunOptions)) };
  },
});

/** Tool #2: revive the handle, deliver the human's choice, run to the next pause. */
export const resumeWorkflow = defineTool({
  name: "resume_workflow",
  description:
    "Resume a paused email-drafting workflow. Pass the handle from start_workflow " +
    "and the eventType of the choice the user picked. Include `text` when that " +
    "choice was marked 'needs text'; otherwise pass null.",
  input: v.object({
    handle: v.pipe(v.string(), v.description("Opaque handle from start_workflow")),
    eventType: v.pipe(
      v.string(),
      v.description("The chosen eventType, e.g. SEND or REQUEST_CHANGES"),
    ),
    text: v.nullable(v.string()),
  }),
  output: resultSchema,
  async run({ data }) {
    return {
      output: toModelResult(
        await resumeDraft(data.handle, data.eventType, data.text, toolRunOptions),
      ),
    };
  },
});

/**
 * The Flue 2 agent — in Flue 2 the agent IS the exported function, and the
 * instructions are its return value. Every render attaches the same config:
 * the machine owns the steps, so the agent body has nothing to branch on. One
 * cheap conversational model — the workflow's own models are declared
 * per-actor in ../email-drafter and never appear here.
 *
 * No `useSandbox`: Flue 2 mounts no sandbox unless one is asked for, and this
 * agent needs no file or shell tools. Its whole world is the two bridge tools.
 */
export function MachineOwnedAgent() {
  useModel("openai/gpt-5.4-mini");
  useTool(startWorkflow);
  useTool(resumeWorkflow);

  return (
    "You help people send email, but you never write or send it yourself; a " +
    "state machine owns the drafting workflow. Call start_workflow with the " +
    "user's request. If the result is pending, show the draft and present its " +
    "choices in plain language; once the user picks one, call resume_workflow " +
    "with the same handle, that choice's eventType, and any text it asked for. " +
    "When the result is done, say how many emails were sent."
  );
}

// ─── Keyless model: pi's faux provider, reacting to the machine's pauses ───
//
// The demo runs on the real Flue runtime either way; only the model changes.
// Without a key, a faux response factory plays it — and because the factory
// receives the very `Context` the runtime built for the turn, it can read the
// last bridge-tool result and react to the choices the machine published
// instead of replaying a fixed script. A real evaluator may route through the
// needs-details pause, and a hardcoded SEND → END sequence would be refused
// there (and rightly so).

/** Pull the eventType back out of a projected choice line ("SEND (Send)"). */
function eventTypeOf(choiceLine: string): string {
  return choiceLine.split(" ")[0]!;
}

/**
 * The unattended stand-in for a human. Each entry is an event that needs no
 * text, so the demo can answer any pause the machine reaches:
 *
 *   - DRAFT_ANYWAY: the needs-details pause. A real host would collect the
 *     missing details from the user and send MORE_INFO with them instead.
 *   - SEND: the review pause.
 *   - END: the "send another?" pause.
 */
const DEMO_EVENT_PREFERENCE = ["SEND", "DRAFT_ANYWAY", "END"];

function chooseEventType(accepted: string[]): string {
  const chosen = DEMO_EVENT_PREFERENCE.find((eventType) => accepted.includes(eventType));
  if (!chosen) throw new Error(`No demo answer for pause accepting: ${accepted.join(", ")}`);
  return chosen;
}

/** Safety cap so a misbehaving model can never spin this demo forever. */
const MAX_STEPS = 8;

const BRIDGE_TOOLS = new Set(["start_workflow", "resume_workflow"]);

/** The latest bridge-tool result in the turn's context, as the model sees it. */
function lastBridgeResult(messages: readonly Message[]): ReturnType<typeof toModelResult> | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== "toolResult" || !BRIDGE_TOOLS.has(message.toolName)) continue;
    const text = message.content.find((part) => part.type === "text")?.text;
    return text ? JSON.parse(text) : null;
  }
  return null;
}

const DEMO_PROMPT = "Tell the team the deploy pipeline is twice as fast now.";

/** A faux provider that answers each pause the way the demo's stand-in human would. */
export function scriptedModel() {
  const respond: FauxResponseFactory = (context: Context) => {
    const result = lastBridgeResult(context.messages);

    if (!result) {
      return fauxAssistantMessage([fauxToolCall("start_workflow", { prompt: DEMO_PROMPT })], {
        stopReason: "toolUse",
      });
    }
    if (result.status !== "pending") {
      return fauxAssistantMessage(`Done — ${result.sentCount} email(s) sent.`);
    }

    const eventType = chooseEventType(result.choices.map(eventTypeOf));
    return fauxAssistantMessage(
      [fauxToolCall("resume_workflow", { handle: result.handle, eventType, text: null })],
      { stopReason: "toolUse" },
    );
  };

  const faux = fauxProvider({ provider: "openai", models: [{ id: "gpt-5.4-mini" }] });
  faux.setResponses(Array.from({ length: MAX_STEPS + 2 }, () => respond));
  return faux.provider;
}

// ─── Demo ───
//
// The agent is conversational, so a real model does the right thing at a pause:
// it stops and asks the human. The demo therefore plays the human too, and it
// answers from the machine's own published choices rather than a fixed script —
// a live evaluator may route through the needs-details pause, where a hardcoded
// SEND would be refused (and rightly so).

/** What the stand-in human says next, chosen from what the machine is waiting on. */
function humanReply(): string {
  const pending = [...runs.values()].at(-1);
  if (!pending) return "Please go ahead.";
  const eventType = chooseEventType(choiceLines(pending.interaction).map(eventTypeOf));
  return `I pick ${eventType}. Resume the workflow with that.`;
}

export async function main({ live = false } = {}) {
  if (live) useLiveExecutors();
  completed.length = 0;

  const flue = await start({
    agents: [MachineOwnedAgent],
    providers: live ? undefined : [scriptedModel()],
  });
  try {
    const agent = init(MachineOwnedAgent, { id: `machine-owned-${Date.now()}` });
    // `read` follows the conversation from the stream origin, so each call
    // replays the whole transcript. Print each tool call once.
    const seen = new Set<string>();

    for (let step = 0; step < MAX_STEPS && completed.length === 0; step++) {
      const message = step === 0 ? DEMO_PROMPT : humanReply();
      console.log(`\n[user] ${message}`);
      const reply = await agent.read(await agent.dispatch(message), {
        onEvent: (chunk) => {
          if (chunk.type === "tool-input" && !seen.has(chunk.toolCallId)) {
            seen.add(chunk.toolCallId);
            console.log(`[agent calls ${chunk.toolName}]`, JSON.stringify(chunk.input));
          }
        },
      });
      console.log(`[agent] ${reply.text}`);
    }

    console.log(
      "\nSent:",
      completed[0]?.map((email) => email.subject),
    );

    assert.equal(completed.length, 1);
    assert.equal(completed[0]?.length, 1);
  } finally {
    await flue.stop();
  }
}
