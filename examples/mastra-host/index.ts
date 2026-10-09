/**
 * Mastra host: a real Mastra agent (`@mastra/core`, not a shim) driving the
 * email-draft machine from ../email-drafter through two tools.
 *
 * The same bridge every framework host in this repo uses (../machine-as-tool is
 * the framework-free version of it: same `persist()` / `getInteraction` /
 * `result.ignored` protocol, but the handle IS the persisted
 * snapshot there, so it needs no run store):
 *
 *   - `start_workflow` runs `runAgent(emailDrafter, ...)` to its first idle,
 *     delivers the user's request, persists the snapshot, and returns a JSON-safe
 *     { handle, interaction, draft }.
 *   - `resume_workflow` reloads that snapshot and delivers the human's event.
 *
 * Everything the host owns lives inside `createHost({ executors, judge,
 * store })`: the executors and judge model it runs with (the drafter's prompt
 * check is a Jev judgment), the snapshot store, the handle counter, and the two
 * tools. Nothing is module-level mutable state, so two hosts (one per request
 * in a server, or one per test) never share a run.
 *
 * The machine owns legality and state; the Mastra agent only converses. Nothing
 * here hardcodes a state name or an event payload shape: the host reads the
 * rendered interaction with `getInteraction(snapshot)` and delivers free text to
 * whichever event that interaction named as its `textEvent`.
 * An event the state does not handle is ignored by the machine (`result.ignored`),
 * so no hand-rolled legality check lives in the tools.
 *
 * Run: OPENAI_API_KEY=... TYPESAFE_AI_API_KEY=... npx tsx examples/mastra-host/index.ts
 *   The live Mastra agent calls the two tools, and the machine runs against
 *   real generations and a real Jev judgment.
 */
import { z } from "zod";
import type { Snapshot } from "xstate";
import type { Experimental_DecisionModel } from "ai";
import { Agent } from "@mastra/core/agent";
import { createTool, isValidationError, type ValidationError } from "@mastra/core/tools";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import {
  getInteraction,
  parseAgentEvent,
  createAgentRuntime,
  runToQuiescence,
  type AgentRequestExecutors,
  type AgentRunResult,
} from "@statelyai/agent";
import {
  createEvaluatePrompt,
  emailDrafter,
  models,
  type DrafterEvent,
  type Interaction,
} from "../email-drafter/agent-logic.js";

// ─── Shared shapes ───

const draftSchema = z.object({ to: z.string(), subject: z.string(), body: z.string() });

/**
 * The shipped interaction protocol as `getInteraction` renders it: a resolved
 * `label`, the choices the machine will currently accept, and the event free
 * text belongs to. The host never redeclares what a pause *means* — this is
 * only the wire shape Mastra validates the tool output against.
 */
const interactionSchema = z.object({
  label: z.string(),
  events: z.array(
    z.object({
      type: z.string(),
      label: z.string(),
      style: z.string().optional(),
      event: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
  textEvent: z.string().optional(),
});

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
  // A tool error is a *result*, not an exception: the model is the caller, and
  // it can recover by starting a new workflow.
  z.object({
    status: z.literal("error"),
    error: z.string(),
  }),
]);

export type ToolResult = z.infer<typeof resultSchema>;

// ─── Snapshot store ───
//
// What the host persists between tool calls. The stored `interaction` is what
// lets `resume_workflow` map an eventType back to its payload generically.

export interface StoredRun {
  snapshot: Snapshot<unknown>;
  interaction: Interaction | null;
}

/** The store the host writes runs to. Back it with Redis/Postgres unchanged. */
export interface RunStore {
  get(handle: string): StoredRun | undefined;
  set(handle: string, run: StoredRun): void;
  delete(handle: string): void;
}

/** The default store: one `Map`, owned by one host instance. */
export function createInMemoryRunStore(): RunStore {
  const runs = new Map<string, StoredRun>();
  return {
    get: (handle) => runs.get(handle),
    set: (handle, run) => void runs.set(handle, run),
    delete: (handle) => void runs.delete(handle),
  };
}

// ─── The host ───

export interface CreateHostOptions {
  /** Model executors every tool call runs with. */
  executors: AgentRequestExecutors;
  /**
   * The judge model for the drafter's prompt check. Omitted, the machine's own
   * Jev judgment reads `TYPESAFE_AI_API_KEY` from the environment.
   */
  judge?: Experimental_DecisionModel;
  /** Where paused runs are persisted. Defaults to a fresh in-memory store. */
  store?: RunStore;
}

/**
 * Build one host: the two bridge functions, the two Mastra tools wrapping them,
 * and a Mastra agent that has been handed those tools.
 */
export function createHost({
  executors,
  judge,
  store = createInMemoryRunStore(),
}: CreateHostOptions) {
  let nextHandle = 0;
  const run = {
    executors,
    ...(judge ? { actors: { evaluatePrompt: createEvaluatePrompt(judge) } } : {}),
  };

  /**
   * Build the machine event for `eventType`, attaching `text` to the event the
   * interaction named as its `textEvent` and merging any fixed fields the
   * choice declared. The eventType arrives as a model-supplied string, so the
   * payload is PARSED at this boundary instead of cast through it:
   * `parseAgentEvent` checks it against the machine's own event schemas and
   * returns the machine's event union. If the state has no transition for the
   * event, the machine ignores it and the run reports `result.ignored`.
   */
  function buildEvent(
    interaction: Interaction | null,
    eventType: string,
    text: string | null,
  ): DrafterEvent {
    const choice = interaction?.events.find((candidate) => candidate.type === eventType);
    const payload = text !== null && interaction?.textEvent === eventType ? { text } : {};
    return parseAgentEvent(emailDrafter, { ...choice?.event, ...payload, type: eventType });
  }

  /** Fold a run result into a JSON-safe tool result, persisting on every pause. */
  function toToolResult(result: AgentRunResult<typeof emailDrafter>, handle: string): ToolResult {
    if (result.status === "error") throw result.error;
    if (result.status === "done") {
      store.delete(handle);
      return { status: "done", sentEmails: result.output.sentEmails };
    }

    const interaction = getInteraction(result.snapshot) ?? null;
    store.set(handle, { snapshot: result.persist(), interaction });

    return {
      status: "pending",
      handle,
      interaction,
      draft: result.snapshot.context.draft,
    };
  }

  /**
   * Bridge #1: start the machine, hand it the user's request, run to the first
   * pause. The opening pause publishes a `textEvent`, so the request is
   * delivered through that rather than a literal `PROMPT_SUBMITTED`.
   */
  async function startDraft(prompt: string): Promise<ToolResult> {
    const handle = `draft-${++nextHandle}`;
    const opened = await runToQuiescence(
      createAgentRuntime(emailDrafter, {
        ...run,
      }),
      {
        ...run,
        input: undefined,
      },
    );
    const pending = toToolResult(opened, handle);
    if (pending.status !== "pending") return pending;
    if (!pending.interaction?.textEvent) {
      return {
        status: "error",
        error: "The opening pause published no text interaction to deliver the request through.",
      };
    }

    return resumeDraft(handle, pending.interaction.textEvent, prompt);
  }

  /** Bridge #2: reload the persisted snapshot, deliver the event, run to the next pause. */
  async function resumeDraft(
    handle: string,
    eventType: string,
    text: string | null = null,
  ): Promise<ToolResult> {
    const stored = store.get(handle);
    if (!stored) {
      return { status: "error", error: `Unknown handle: ${handle}. Start a new workflow.` };
    }

    const result = await runToQuiescence(
      createAgentRuntime(emailDrafter, {
        ...run,
      }),
      {
        ...run,
        snapshot: stored.snapshot,
        event: buildEvent(stored.interaction, eventType, text),
      },
    );
    // The state has no transition for the event, so the machine ignored it.
    // Not a library error: `runAgent` settled normally and named the event on
    // `result.ignored`. This host reports it the way it reports a bad handle.
    if (result.ignored) {
      return {
        status: "error",
        error: `'${result.ignored.type}' does not apply in the current state.`,
      };
    }
    return toToolResult(result, handle);
  }

  // ─── The Mastra tools ───
  //
  // `createTool` from @mastra/core: `execute` is positional, `(inputData, ctx)`,
  // and the input arrives already validated against `inputSchema`.

  const startWorkflow = createTool({
    id: "start_workflow",
    description:
      "Start an email-drafting workflow from the user's request. Returns 'pending' " +
      "with a handle, the current draft, and an interaction describing the choice to " +
      "present, or 'done' with the emails that were sent.",
    inputSchema: z.object({
      prompt: z.string().describe("The user's email request, in their own words"),
    }),
    outputSchema: resultSchema,
    execute: async ({ prompt }) => startDraft(prompt),
  });

  const resumeWorkflow = createTool({
    id: "resume_workflow",
    description:
      "Resume a paused email-drafting workflow. Pass the handle from start_workflow " +
      "and the type of the choice the user picked (from the interaction's events). " +
      "Include `text` when the interaction's textEvent is the choice you picked.",
    inputSchema: z.object({
      handle: z.string().describe("The handle returned by start_workflow"),
      eventType: z.string().describe("The chosen event type, e.g. SEND or REQUEST_CHANGES"),
      text: z
        .string()
        .nullable()
        .describe("Free text for the interaction's textEvent choice; otherwise null"),
    }),
    outputSchema: resultSchema,
    execute: async ({ handle, eventType, text }) => resumeDraft(handle, eventType, text),
  });

  // The object keys below are the names the model sees, so they stay snake_case
  // and match each tool's `id`.
  const agent = new Agent({
    id: "email-drafter-host",
    name: "Email Drafter Host",
    instructions:
      "You help people send email, but you never write or send it yourself; a state " +
      "machine owns the drafting workflow. Call start_workflow with the user's request. " +
      "When a result is 'pending', show the draft and present the interaction's choices " +
      "in plain language; once the user picks one, call resume_workflow with the same " +
      "handle, that choice's type, and any text it asked for. When a result is " +
      "'done', summarise the emails that were sent.",
    model: "openai/gpt-5.4-mini",
    tools: { start_workflow: startWorkflow, resume_workflow: resumeWorkflow },
  });

  return { startDraft, resumeDraft, startWorkflow, resumeWorkflow, agent };
}

export type EmailDrafterHost = ReturnType<typeof createHost>;

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

/** Hand the two tools to the real Mastra agent loop. */
export async function main() {
  if (!process.env.OPENAI_API_KEY || !process.env.TYPESAFE_AI_API_KEY) {
    throw new Error("Set OPENAI_API_KEY and TYPESAFE_AI_API_KEY to run this example.");
  }
  const { agent } = createHost({ executors: createAiSdkExecutors({ models }) });
  const result = await agent.generate(
    "Draft an email telling the team the deploy pipeline is twice as fast, then send it.",
    { maxSteps: 6 },
  );
  console.log(result.text);
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
