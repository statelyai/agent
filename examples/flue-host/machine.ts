/**
 * The state-machine "brain" both Flue tools bridge to. The machine owns
 * legality and state; the Flue LLM agent just converses and calls the tools.
 *
 * Refund flow: classify → (auto-approve | needs-human idle) → execute → done,
 * with a REJECT path. `awaitingApproval` has no invoke, so `runAgent` settles
 * `idle` there and hands the host a typed `meta.interaction` to render.
 *
 * `startRefund` / `resumeRefund` are the pure bridge: they call `runAgent` and
 * fold the result into a JSON-safe `ToolResult`. The Flue tools (index.ts) are
 * thin `run()` wrappers over these.
 */
import { z } from "zod";
import { createAsyncLogic } from "xstate";
import {
  getStateMeta,
  runAgent,
  setupAgent,
  type RunAgentOptions,
  type RunAgentResult,
} from "../../src/index.js";

// Typed interaction protocol handed to the host (a `select` with choices, each
// optionally carrying a follow-up text `input`). Schema-typed meta = a real
// contract for the host, not Record<string, unknown>.
const metaSchema = z.object({
  interaction: z
    .object({
      type: z.literal("select"),
      label: z.string(),
      choices: z.array(
        z.object({
          label: z.string(),
          eventType: z.string(),
          input: z
            .object({ type: z.literal("text"), label: z.string(), field: z.string() })
            .optional(),
        }),
      ),
    })
    .optional(),
});

const agentSetup = setupAgent({
  actorSources: {
    // Stand-in for the real refund side effect; runAgent uses it as-is.
    processRefund: createAsyncLogic({ run: async () => ({ ok: true }) }),
  },
  context: z.object({ amount: z.number(), orderId: z.string(), reason: z.string().nullable() }),
  input: z.object({ amount: z.number(), orderId: z.string() }),
  output: z.object({ refunded: z.boolean(), reason: z.string().nullable() }),
  meta: metaSchema,
  events: { APPROVE: z.object({}), REJECT: z.object({ reason: z.string() }) },
  requests: {
    // Stands in for a real policy/fraud model call.
    classifyRefund: {
      schemas: {
        input: z.object({ amount: z.number(), orderId: z.string() }),
        output: z.object({ autoApprove: z.boolean() }),
      },
      model: "classifier",
      system:
        "You classify refund requests. autoApprove=true only for low-risk refunds " +
        "at or below the $100 auto-approval limit; otherwise autoApprove=false.",
      prompt: ({ input }) =>
        `Order ${input.orderId}, refund amount $${input.amount}. Auto-approve?`,
    },
  },
});

export const refundMachine = agentSetup.createMachine({
  id: "refund",
  context: ({ input }) => ({ amount: input.amount, orderId: input.orderId, reason: null }),
  initial: "classifying",
  states: {
    classifying: {
      invoke: {
        src: "classifyRefund",
        input: ({ context }) => ({ amount: context.amount, orderId: context.orderId }),
        // Branch on the classification: low-risk auto-approves, else idle HITL.
        onDone: ({ output }) =>
          output.autoApprove ? { target: "executing" } : { target: "awaitingApproval" },
      },
    },
    awaitingApproval: {
      // No invoke: runAgent settles idle here. `meta.interaction` is the typed
      // contract the host renders and resumes with the human's event.
      meta: {
        interaction: {
          type: "select",
          label: "Approve this refund?",
          choices: [
            { label: "Approve", eventType: "APPROVE" },
            {
              label: "Reject",
              eventType: "REJECT",
              input: { type: "text", label: "Reason", field: "reason" },
            },
          ],
        },
      },
      on: {
        APPROVE: { target: "executing" },
        REJECT: ({ event }) => ({ target: "rejected", context: { reason: event.reason } }),
      },
    },
    executing: { invoke: { src: "processRefund", onDone: { target: "done" } } },
    rejected: {
      type: "final",
      output: ({ context }) => ({ refunded: false, reason: context.reason }),
    },
    done: { type: "final", output: () => ({ refunded: true, reason: null }) },
  },
});

// ─── JSON-safe bridge shared by both tools ───

/** What the host persists between tool calls: just the serialized snapshot. */
export type Handle = string;

type Interaction = NonNullable<z.infer<typeof metaSchema>["interaction"]>;

export type ToolResult =
  | { status: "pending"; handle: Handle; interaction: Interaction | null }
  | { status: "done"; refunded: boolean; reason: string | null };

/**
 * Keyless mock so the example runs with no API key or network. Returns
 * autoApprove=false so every run reaches the human-approval bridge; a real
 * classifier would auto-approve small refunds. Swap for
 * `createAiSdkExecutors({ models: { classifier: openai("gpt-5.4-mini") } })`.
 */
export const mockRunOptions: RunAgentOptions<typeof refundMachine> = {
  executors: { generateText: async () => ({ output: { autoApprove: false } }) },
};

function toToolResult(result: RunAgentResult<typeof refundMachine>): ToolResult {
  if (result.status === "error") throw result.error;
  if (result.status === "done") {
    return { status: "done", refunded: result.output.refunded, reason: result.output.reason };
  }
  // idle → serialize the snapshot to a JSON-safe handle (survives any store).
  return {
    status: "pending",
    handle: JSON.stringify(result.snapshot),
    interaction: getStateMeta(result.snapshot).interaction ?? null,
  };
}

/** Bridge #1: start the workflow, run to first idle (or done), return a handle. */
export async function startRefund(
  input: { amount: number; orderId: string },
  runOptions: RunAgentOptions<typeof refundMachine> = mockRunOptions,
): Promise<ToolResult> {
  return toToolResult(await runAgent(refundMachine, { ...runOptions, input }));
}

/** Bridge #2: revive the handle, deliver the event, run to next idle/done. */
export async function resumeRefund(
  handle: Handle,
  event: { type: "APPROVE" } | { type: "REJECT"; reason: string },
  runOptions: RunAgentOptions<typeof refundMachine> = mockRunOptions,
): Promise<ToolResult> {
  const snapshot = JSON.parse(handle);
  return toToolResult(await runAgent(refundMachine, { ...runOptions, snapshot, event }));
}
