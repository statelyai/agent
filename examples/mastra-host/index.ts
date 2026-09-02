/**
 * Mastra host: a real Mastra agent (`@mastra/core`, not a shim) driving the
 * email-draft machine from ../email-drafter through two tools.
 *
 * The same bridge every framework host in this repo uses:
 *
 *   - `start_workflow` runs `runAgent(emailDrafter, ...)` to its first idle,
 *     delivers the user's request, persists the snapshot, and returns a JSON-safe
 *     { handle, interaction, draft }.
 *   - `resume_workflow` reloads that snapshot and delivers the human's event.
 *
 * The machine owns legality and state; the Mastra agent only converses. Nothing
 * here hardcodes a state name; the event to send is derived from the machine's
 * own `meta.interaction`, so adding a state to the machine needs no host change.
 * The one exception is `startDraft`'s `"PROMPT_SUBMITTED"` fallback, used only if
 * the opening pause publishes no text interaction to read the event type from.
 * Illegal resumes are refused by `runAgent` itself (AgentIllegalResumeEventError),
 * so no hand-rolled legality check lives in the tools.
 *
 * Snapshots live in an in-memory `Map` keyed by handle (same shape as
 * examples/express-host); swap it for Redis/Postgres and the tools are unchanged.
 *
 * Run: npx tsx examples/mastra-host/index.ts
 *   No API key -> keyless mock executors drive the machine end to end.
 *   OPENAI_API_KEY=... -> also runs the live Mastra agent over the same tools.
 */
import assert from "node:assert/strict";
import { z } from "zod";
import type { EventFromLogic, Snapshot } from "xstate";
import { Agent } from "@mastra/core/agent";
import {
  createTool,
  isValidationError,
  noopObserve,
  type ValidationError,
} from "@mastra/core/tools";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import {
  getStateMeta,
  runAgent,
  type AgentTextRequest,
  type RunAgentOptions,
  type RunAgentResult,
} from "@statelyai/agent";
import { emailDrafter, metaSchema, models } from "../email-drafter/agent-logic.js";

// ─── Shared shapes ───

const draftSchema = z.object({ to: z.string(), subject: z.string(), body: z.string() });

/**
 * The machine's own interaction protocol, reused verbatim as the tools' output
 * schema. The host never redeclares what a pause looks like: `metaSchema` from
 * the email-drafter IS the contract.
 */
const interactionSchema = metaSchema.shape.interaction.unwrap();
type Interaction = z.infer<typeof interactionSchema>;

const resultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("pending"),
    handle: z.string(),
    interaction: interactionSchema.nullable(),
    draft: draftSchema.nullable(),
  }),
  z.object({
    status: z.literal("done"),
    sentEmails: z.array(draftSchema),
  }),
]);

export type ToolResult = z.infer<typeof resultSchema>;

// ─── Snapshot store ───
//
// What the host persists between tool calls. The stored `interaction` is what
// lets `resume_workflow` map an eventType back to its payload field generically.

interface StoredRun {
  snapshot: Snapshot<unknown>;
  interaction: Interaction | null;
}

const runs = new Map<string, StoredRun>();

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
 * eventType arrives as a model-supplied string. `runAgent` still validates it
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
    return { status: "done", sentEmails: result.output.sentEmails };
  }

  const meta = getStateMeta<typeof result.snapshot, z.infer<typeof metaSchema>>(result.snapshot);
  const interaction = meta.interaction ?? null;
  runs.set(handle, { snapshot: result.persist(), interaction });

  return {
    status: "pending",
    handle,
    interaction,
    draft: result.snapshot.context.draft,
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

// ─── The Mastra tools ───
//
// `createTool` from @mastra/core: `execute` is positional, `(inputData, ctx)`,
// and the input arrives already validated against `inputSchema`.

export const startWorkflow = createTool({
  id: "start_workflow",
  description:
    "Start an email-drafting workflow from the user's request. Returns 'pending' " +
    "with a handle, the current draft, and an interaction describing the choice to " +
    "present, or 'done' with the emails that were sent.",
  inputSchema: z.object({
    prompt: z.string().describe("The user's email request, in their own words"),
  }),
  outputSchema: resultSchema,
  execute: async ({ prompt }) => startDraft(prompt, toolRunOptions),
});

export const resumeWorkflow = createTool({
  id: "resume_workflow",
  description:
    "Resume a paused email-drafting workflow. Pass the handle from start_workflow " +
    "and the eventType of the choice the user picked (from the interaction). " +
    "Include `text` when that choice declared an input field.",
  inputSchema: z.object({
    handle: z.string().describe("The handle returned by start_workflow"),
    eventType: z
      .string()
      .describe("The chosen interaction's eventType, e.g. SEND or REQUEST_CHANGES"),
    text: z
      .string()
      .nullable()
      .describe("Free text for choices that declare an input field; otherwise null"),
  }),
  outputSchema: resultSchema,
  execute: async ({ handle, eventType, text }) =>
    resumeDraft(handle, eventType, text, toolRunOptions),
});

// ─── The Mastra agent ───
//
// The object keys below are the names the model sees, so they stay snake_case
// and match each tool's `id`.

export const emailHostAgent = new Agent({
  id: "email-drafter-host",
  name: "Email Drafter Host",
  instructions:
    "You help people send email, but you never write or send it yourself; a state " +
    "machine owns the drafting workflow. Call start_workflow with the user's request. " +
    "When a result is 'pending', show the draft and present the interaction's choices " +
    "in plain language; once the user picks one, call resume_workflow with the same " +
    "handle, that choice's eventType, and any text it asked for. When a result is " +
    "'done', summarise the emails that were sent.",
  model: "openai/gpt-5.4-mini",
  tools: { start_workflow: startWorkflow, resume_workflow: resumeWorkflow },
});

/**
 * Narrow a direct `tool.execute(...)` call. Mastra widens the return to
 * `Out | ValidationError | void` because it validates input and output against
 * the declared schemas and *returns* failures instead of throwing. Hosts calling
 * a tool outside the model loop have to decide what a failure means; here it is
 * a bug, so it throws.
 */
export function unwrapToolResult(value: ToolResult | ValidationError<unknown> | void): ToolResult {
  if (!value) throw new Error("Tool returned no result");
  if (isValidationError(value)) throw new Error(`Tool schema validation failed: ${value.message}`);
  return value;
}

// ─── Demo ───

/**
 * Exercise the tool bridge exactly as Mastra's tool loop would: call each
 * tool's own `execute`. No API key, no network: the mock executors stand in
 * for the two model calls the machine makes.
 */
export async function main() {
  const started = unwrapToolResult(
    await startWorkflow.execute!(
      { prompt: "Tell the team the deploy pipeline is twice as fast now." },
      { observe: noopObserve },
    ),
  );
  assert.equal(started.status, "pending");
  if (started.status !== "pending") return;

  console.log(
    `\n--- Draft ---\nTo: ${started.draft?.to}\nSubject: ${started.draft?.subject}\n\n${started.draft?.body}\n-------------`,
  );
  console.log(`\n${started.interaction?.label}`);
  console.log("\n[user sends it]\n");

  const sent = unwrapToolResult(
    await resumeWorkflow.execute!(
      { handle: started.handle, eventType: "SEND", text: null },
      { observe: noopObserve },
    ),
  );
  assert.equal(sent.status, "pending");
  if (sent.status !== "pending") return;
  console.log(sent.interaction?.label);
  console.log("\n[user is done]\n");

  const finished = unwrapToolResult(
    await resumeWorkflow.execute!(
      { handle: started.handle, eventType: "END", text: null },
      { observe: noopObserve },
    ),
  );
  assert.equal(finished.status, "done");
  // The machine's `failed` state is also final, so "done" alone doesn't mean the
  // run succeeded — it can finish with nothing sent. Assert on the output.
  assert.ok(
    finished.status === "done" && finished.sentEmails.length >= 1,
    "run finished without sending an email (the machine reached `failed`)",
  );
  console.log("Result:", finished);
}

/** The live path: hand the same two tools to the real Mastra agent loop. */
export async function mainLive() {
  useLiveExecutors();
  const result = await emailHostAgent.generate(
    "Draft an email telling the team the deploy pipeline is twice as fast, then send it.",
    { maxSteps: 6 },
  );
  console.log(result.text);
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  const run = process.env.OPENAI_API_KEY ? mainLive : main;
  run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
