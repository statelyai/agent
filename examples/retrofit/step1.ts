/**
 * STEP 1 — phases become states; SDK calls become executors.
 *
 * Moved: the `while` loop's phases (triage, resolving, awaiting-approval) are now
 * explicit states, and the model calls move verbatim into a custom `generateText`
 * executor — the retry/backoff wrapper from `before.ts` is unchanged, just
 * wrapping the executor now.
 * Stayed (for now): tool choice is still a structured text request whose union
 * output is dispatched by a nested `if/else` (here, a routing `choice` state),
 * and the approval pause is still the `{ pending }` sentinel — a `needsApproval`
 * final state whose output the runner reshapes into `{ pending, resume }`.
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";
import {
  createAgentSchemas,
  runAgent,
  setupAgent,
  type AgentRequestExecutors,
} from "@statelyai/agent";

const REFUND_LIMIT = 100;
const models = defineModels({ agent: openai("gpt-5.4-mini") });

// The tool-choice union — still a model output validated after the fact, exactly
// like the loop's `toolCalls`. Step 2 turns this into typed events + a decision.
const actionSchema = z.union([
  z.object({ kind: z.literal("refund"), amount: z.number(), reason: z.string() }),
  z.object({ kind: z.literal("escalate"), reason: z.string() }),
  z.object({ kind: z.literal("resolve"), message: z.string() }),
]);

const schemas = createAgentSchemas({
  context: z.object({
    ticket: z.string(),
    action: actionSchema.nullable(),
    pendingRefund: z.number().nullable(),
    refunded: z.boolean(),
    escalated: z.boolean(),
    resolution: z.string().nullable(),
  }),
  input: z.object({ ticket: z.string() }),
  output: z.object({
    refunded: z.boolean(),
    escalated: z.boolean(),
    resolution: z.string(),
    // The sentinel, still carried out as machine output for the runner to detect.
    pending: z.number().nullable(),
  }),
});

const agentSetup = setupAgent({
  schemas,
  models,
  requests: {
    decideAction: {
      schemas: { input: z.object({ ticket: z.string() }), output: actionSchema },
      model: "agent",
      system:
        "You are a support agent. Choose one action: refund (with amount+reason), " +
        "escalate (with reason), or resolve (with a closing message).",
      prompt: ({ input }) => input.ticket,
    },
  },
  states: {
    routing: { context: { action: actionSchema } },
    needsApproval: { context: { pendingRefund: z.number() } },
  },
});

export const supportMachineStep1 = agentSetup.createMachine({
  id: "retrofit-support-step1",
  context: ({ input }) => ({
    ticket: input.ticket,
    action: null,
    pendingRefund: null,
    refunded: false,
    escalated: false,
    resolution: null,
  }),
  output: ({ context }) => ({
    refunded: context.refunded,
    escalated: context.escalated,
    resolution: context.resolution ?? "",
    pending: context.pendingRefund,
  }),
  initial: "deciding",
  states: {
    deciding: {
      invoke: {
        src: "decideAction",
        input: ({ context }) => ({ ticket: context.ticket }),
        onDone: ({ output }) => ({ target: "routing", context: { action: output } }),
      },
    },
    // The nested tool-choice `if/else`, still here — just as a routing state.
    routing: {
      type: "choice",
      choice: ({ context }) => {
        const action = context.action;
        if (action.kind === "refund") {
          if (action.amount > REFUND_LIMIT) {
            return { target: "needsApproval", context: { pendingRefund: action.amount } };
          }
          return {
            target: "refunded",
            context: {
              refunded: true,
              resolution: `Refunded $${action.amount}: ${action.reason}`,
            },
          };
        }
        if (action.kind === "escalate") {
          return {
            target: "escalated",
            context: { escalated: true, resolution: `Escalated: ${action.reason}` },
          };
        }
        return { target: "resolved", context: { resolution: action.message } };
      },
    },
    // The sentinel as a final state: the runner reshapes `output.pending` into
    // `{ pending, resume }`. Step 3 makes this a real idle state instead.
    needsApproval: { type: "final" },
    refunded: { type: "final" },
    escalated: { type: "final" },
    resolved: { type: "final" },
  },
});

/** The retry/backoff wrapper from `before.ts`, now wrapping the executor. */
function buildExecutors(): Pick<AgentRequestExecutors, "generateText"> {
  const ai = createAiSdkExecutors({ models });
  const generateText: NonNullable<AgentRequestExecutors["generateText"]> = async (
    request,
    info,
  ) => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await ai.generateText(request, info);
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 50));
      }
    }
    throw new Error(`generateText failed after 3 attempts: ${String(lastError)}`);
  };
  return { generateText };
}

export interface Step1Result {
  refunded: boolean;
  escalated: boolean;
  resolution: string;
}
export interface Step1Pending {
  pending: number;
  resume: (approved: boolean) => Promise<Step1Result>;
}

/**
 * Same external contract as `before.ts`: resolve, or hand back `{ pending, resume }`.
 * The pause still loses machine state — `resume` re-runs from scratch with the
 * decision already made. Step 3 fixes this with snapshot persistence.
 */
export async function runSupportStep1(
  ticket: string,
  executors = buildExecutors(),
): Promise<Step1Result | Step1Pending> {
  const result = await runAgent(supportMachineStep1, { input: { ticket }, executors });
  if (result.status !== "done") throw new Error(`unexpected status ${result.status}`);

  if (result.output.pending !== null) {
    const amount = result.output.pending;
    return {
      pending: amount,
      resume: async (approved: boolean) => ({
        refunded: approved,
        escalated: !approved,
        resolution: approved
          ? `Refunded $${amount} after approval`
          : `Refund of $${amount} denied; escalated`,
      }),
    };
  }
  return {
    refunded: result.output.refunded,
    escalated: result.output.escalated,
    resolution: result.output.resolution,
  };
}
