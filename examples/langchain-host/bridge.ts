/**
 * Direction B — the machine as a pair of LangChain tools.
 *
 * `start_workflow` / `resume_workflow` are `DynamicStructuredTool`s bridging a
 * LangChain agent loop (`createAgent`) to the email-drafter machine from
 * ../email-drafter/agent-logic.js:
 *
 *   - `start_workflow` runs `runAgent(emailDrafter, ...)` to its first idle,
 *     delivers the user's request, persists the snapshot, and returns a
 *     JSON-safe { handle, interaction, draft }.
 *   - `resume_workflow` reloads that snapshot and delivers the human's event.
 *
 * The machine owns legality and state; the LangChain agent only converses.
 * Nothing here hardcodes a state name — the event to send is derived from the
 * machine's own `meta.interaction`. Illegal resumes are refused by `runAgent`
 * itself (AgentIllegalResumeEventError), so no hand-rolled legality check
 * lives in the tools. Same bridge as ../mastra-host/index.ts.
 *
 * Snapshots live in an in-memory `Map` keyed by handle (same shape as
 * ../express-host); swap it for Redis/Postgres and the tools are unchanged.
 */
import { z } from "zod";
import type { EventFromLogic, Snapshot } from "xstate";
import { DynamicStructuredTool } from "@langchain/core/tools";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { createAgent } from "langchain";
import {
  getStateMeta,
  runAgent,
  type RunAgentOptions,
  type RunAgentResult,
} from "@statelyai/agent";
import { emailDrafter, metaSchema } from "../email-drafter/agent-logic.js";
import { createLangChainExecutors } from "./executors.js";

// ─── Shared shapes ───

const draftSchema = z.object({ to: z.string(), subject: z.string(), body: z.string() });

/**
 * The machine's own interaction protocol, reused verbatim as the tools' result
 * shape. The host never redeclares what a pause looks like: `metaSchema` from
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

interface StoredRun {
  snapshot: Snapshot<unknown>;
  interaction: Interaction | null;
}

const runs = new Map<string, StoredRun>();

// ─── Which executors the machine runs with ───

/**
 * Direction A powering Direction B: the machine inside the LangChain tools is
 * itself driven by a LangChain model. Both halves of the "best of both worlds"
 * in one call — LangChain owns every model call, the machine owns the flow.
 */
export function langChainRunOptions(model: BaseChatModel): RunAgentOptions<typeof emailDrafter> {
  return { executors: createLangChainExecutors({ model }) };
}

/**
 * What the tools run with. Defaults to nothing so importing this module never
 * touches the network; `useModel(...)` installs one.
 */
let toolRunOptions: RunAgentOptions<typeof emailDrafter> | null = null;

/** Point the bridge tools at a LangChain model (scripted or live). */
export function useModel(model: BaseChatModel) {
  toolRunOptions = langChainRunOptions(model);
}

function currentRunOptions(): RunAgentOptions<typeof emailDrafter> {
  if (!toolRunOptions) {
    throw new Error("langchain-host: call useModel(model) before running the bridge tools.");
  }
  return toolRunOptions;
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
  runs.set(handle, { snapshot: result.persistedSnapshot, interaction });

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
  runOptions: RunAgentOptions<typeof emailDrafter> = currentRunOptions(),
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
  runOptions: RunAgentOptions<typeof emailDrafter> = currentRunOptions(),
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

// ─── The LangChain tools ───
//
// `DynamicStructuredTool` from @langchain/core/tools: `schema` validates the
// model's arguments, `func` receives them already parsed. A tool's return value
// becomes the ToolMessage content the agent loop reads back, so these return
// JSON text.

export const startWorkflowTool = new DynamicStructuredTool({
  name: "start_workflow",
  description:
    "Start an email-drafting workflow from the user's request. Returns 'pending' " +
    "with a handle, the current draft, and an interaction describing the choice to " +
    "present, or 'done' with the emails that were sent.",
  schema: z.object({
    prompt: z.string().describe("The user's email request, in their own words"),
  }),
  func: async ({ prompt }) => JSON.stringify(await startDraft(prompt)),
});

export const resumeWorkflowTool = new DynamicStructuredTool({
  name: "resume_workflow",
  description:
    "Resume a paused email-drafting workflow. Pass the handle from start_workflow " +
    "and the eventType of the choice the user picked (from the interaction). " +
    "Include `text` when that choice declared an input field.",
  schema: z.object({
    handle: z.string().describe("The handle returned by start_workflow"),
    eventType: z
      .string()
      .describe("The chosen interaction's eventType, e.g. SEND or REQUEST_CHANGES"),
    text: z
      .string()
      .nullable()
      .describe("Free text for choices that declare an input field; otherwise null"),
  }),
  func: async ({ handle, eventType, text }) =>
    JSON.stringify(await resumeDraft(handle, eventType, text)),
});

export const bridgeTools = [startWorkflowTool, resumeWorkflowTool];

export const SYSTEM_PROMPT =
  "You help people send email, but you never write or send it yourself; a state " +
  "machine owns the drafting workflow. Call start_workflow with the user's request. " +
  "When a result is 'pending', show the draft and present the interaction's choices " +
  "in plain language; once the user picks one, call resume_workflow with the same " +
  "handle, that choice's eventType, and any text it asked for. When a result is " +
  "'done', summarise the emails that were sent.";

/**
 * The LangChain agent loop over the bridge tools. `createAgent` is LangChain
 * 1.x's replacement for `createToolCallingAgent` + `AgentExecutor`; it returns
 * a `ReactAgent` whose `invoke({ messages })` resolves `{ messages }`.
 */
export function createEmailHostAgent(model: BaseChatModel, machineModel: BaseChatModel = model) {
  // The conversing model and the model *inside* the machine are separable, and
  // separate scripts keep the keyless demo readable; live, they are one model.
  useModel(machineModel);
  return createAgent({
    model,
    tools: bridgeTools,
    systemPrompt: SYSTEM_PROMPT,
  });
}
