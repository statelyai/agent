/**
 * STEP 2 — the tool-choice `if/else` becomes a decision + a guard.
 *
 * Moved: the structured `decideAction` union + routing `choice` from step 1
 * become `agent.decide` over typed events, and the `$100` `if` becomes a guard on
 * the REFUND transition. "Which action" is now the model picking one legal event;
 * the threshold is enforced by construction, not by a post-hoc check.
 * Stayed (for now): the approval pause is still the `{ pending }` sentinel — a
 * `needsApproval` final state the runner reshapes. Executors still carry the
 * retry wrapper, now plus `decide`. Step 3 makes the pause a real idle state.
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

const schemas = createAgentSchemas({
  context: z.object({
    ticket: z.string(),
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
    pending: z.number().nullable(),
  }),
  events: {
    REFUND: z.object({ amount: z.number(), reason: z.string() }),
    ESCALATE: z.object({ reason: z.string() }),
    RESOLVE: z.object({ message: z.string() }),
  },
});

const agentSetup = setupAgent({
  schemas,
  models,
  states: {
    needsApproval: {
      schemas: { context: schemas.context.extend({ pendingRefund: z.number() }) },
    },
  },
});

export const supportMachineStep2 = agentSetup.createMachine({
  id: "retrofit-support-step2",
  context: ({ input }) => ({
    ticket: input.ticket,
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
        src: "agent.decide",
        input: ({ context }) => ({
          model: "agent",
          system:
            "You are a support agent. Issue small refunds directly, escalate what " +
            "you cannot resolve, or close with a reply.",
          prompt: context.ticket,
          allowedEvents: ["REFUND", "ESCALATE", "RESOLVE"],
          maxRetries: 2,
        }),
        onError: { target: "escalated" },
      },
      on: {
        // The guard owns the limit: a large refund routes to the pause instead
        // of settling. No prompt can talk past it.
        REFUND: ({ event }) =>
          event.amount <= REFUND_LIMIT
            ? {
                target: "refunded",
                context: {
                  refunded: true,
                  resolution: `Refunded $${event.amount}: ${event.reason}`,
                },
              }
            : { target: "needsApproval", context: { pendingRefund: event.amount } },
        ESCALATE: ({ event }) => ({
          target: "escalated",
          context: { escalated: true, resolution: `Escalated: ${event.reason}` },
        }),
        RESOLVE: ({ event }) => ({ target: "resolved", context: { resolution: event.message } }),
      },
    },
    // Still the sentinel-shaped final state; step 3 makes it idle.
    needsApproval: { type: "final" },
    refunded: { type: "final" },
    escalated: { type: "final" },
    resolved: { type: "final" },
  },
});

/** Retry wrapper on `generateText`; `decide` from the AI SDK adapter. */
function buildExecutors(): Pick<AgentRequestExecutors, "generateText" | "decide"> {
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
  return { generateText, decide: ai.decide };
}

export interface Step2Result {
  refunded: boolean;
  escalated: boolean;
  resolution: string;
}
export interface Step2Pending {
  pending: number;
  resume: (approved: boolean) => Promise<Step2Result>;
}

/** Same external contract as `before.ts`: resolve, or `{ pending, resume }`. */
export async function runSupportStep2(
  ticket: string,
  executors = buildExecutors(),
): Promise<Step2Result | Step2Pending> {
  const result = await runAgent(supportMachineStep2, { input: { ticket }, executors });
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
