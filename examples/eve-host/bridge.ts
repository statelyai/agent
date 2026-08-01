/**
 * The bridge both Eve tools sit on. No machine is defined here: the email-draft
 * machine comes from ../email-drafter, the same one every framework host in this
 * repo drives. This file only owns the host-side plumbing.
 *
 *   - `startDraft` runs `runAgent(emailDrafter, ...)` to its first idle, delivers
 *     the user's request, persists the snapshot, and returns a JSON-safe
 *     { handle, interaction, draft }.
 *   - `resumeDraft` reloads that snapshot and delivers the human's event.
 *
 * The machine owns legality and state; the Eve agent only converses. Nothing
 * here hardcodes a state name; the event to send is derived from the machine's
 * own `meta.interaction`, so adding a state to the machine needs no host change.
 * The one exception is `startDraft`'s `"PROMPT_SUBMITTED"` fallback, used only if
 * the opening pause publishes no text interaction to read the event type from.
 * Illegal resumes are refused by `runAgent` itself (AgentIllegalResumeEventError),
 * so no hand-rolled legality check lives in the tools.
 *
 * Snapshots live in an in-memory `Map` keyed by handle; swap it for Redis or
 * Postgres and the tools are unchanged.
 */
import { z } from "zod";
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
import { emailDrafter, metaSchema, models } from "../email-drafter/agent-logic.js";

// ─── Shared shapes ───

const draftSchema = z.object({ to: z.string(), subject: z.string(), body: z.string() });

/**
 * The machine's own interaction protocol, reused verbatim as the tools' output
 * schema. The host never redeclares what a pause looks like: `metaSchema` from
 * the email-drafter IS the contract. Eve tools take real zod schemas, so the
 * model sees the full discriminated union instead of a flattened summary.
 */
export const interactionSchema = metaSchema.shape.interaction.unwrap();
type Interaction = z.infer<typeof interactionSchema>;

export const resultSchema = z.discriminatedUnion("status", [
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
// lets `resumeDraft` map an eventType back to its payload field generically.

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
  runs.set(handle, { snapshot: persistSnapshot(result.snapshot), interaction });

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
