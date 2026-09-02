/**
 * STEP 3 — the `{ pending }` sentinel becomes an idle state.
 *
 * Moved: `needsApproval` (a final state whose output the runner reshaped) becomes
 * a real idle `awaitingApproval` state — no invoke, an `isIdle` tag, and
 * APPROVE/DENY handlers. `runAgent` now settles `{ status: 'idle', snapshot }`
 * there; the runner persists that snapshot (plain JSON) and resumes with an event
 * in a second `runAgent` call. No closure, no lost state, resumable across
 * processes.
 * Stayed: everything else from step 2 — the decision, the guard, the executors.
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
  }),
  events: {
    REFUND: z.object({ amount: z.number(), reason: z.string() }),
    ESCALATE: z.object({ reason: z.string() }),
    RESOLVE: z.object({ message: z.string() }),
    APPROVE: z.object({}),
    DENY: z.object({ reason: z.string() }),
  },
});

const agentSetup = setupAgent({
  schemas,
  models,
  isIdle: (snapshot) => snapshot.hasTag("awaiting-approval"),
  states: {
    awaitingApproval: {
      schemas: { context: schemas.context.extend({ pendingRefund: z.number() }) },
    },
  },
});

export const supportMachineStep3 = agentSetup.createMachine({
  id: "retrofit-support-step3",
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
        REFUND: ({ event }) =>
          event.amount <= REFUND_LIMIT
            ? {
                target: "refunded",
                context: {
                  refunded: true,
                  resolution: `Refunded $${event.amount}: ${event.reason}`,
                },
              }
            : { target: "awaitingApproval", context: { pendingRefund: event.amount } },
        ESCALATE: ({ event }) => ({
          target: "escalated",
          context: { escalated: true, resolution: `Escalated: ${event.reason}` },
        }),
        RESOLVE: ({ event }) => ({ target: "resolved", context: { resolution: event.message } }),
      },
    },
    // The sentinel, now a first-class idle state.
    awaitingApproval: {
      tags: ["awaiting-approval"],
      on: {
        APPROVE: ({ context }) => ({
          target: "refunded",
          context: {
            refunded: true,
            resolution: `Refunded $${context.pendingRefund} after approval`,
          },
        }),
        DENY: ({ context, event }) => ({
          target: "escalated",
          context: {
            escalated: true,
            resolution: `Refund of $${context.pendingRefund} denied (${event.reason}); escalated`,
          },
        }),
      },
    },
    refunded: { type: "final" },
    escalated: { type: "final" },
    resolved: { type: "final" },
  },
});

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

export interface Step3Result {
  refunded: boolean;
  escalated: boolean;
  resolution: string;
}

/**
 * Resolve in one call, or settle idle at `awaitingApproval`, persist the
 * snapshot, and resume with APPROVE/DENY — the durable replacement for the
 * sentinel + closure.
 */
export async function runSupportStep3(
  ticket: string,
  approve = true,
  executors = buildExecutors(),
): Promise<Step3Result> {
  const first = await runAgent(supportMachineStep3, { input: { ticket }, executors });
  if (first.status === "done") return first.output;
  if (first.status !== "idle") throw new Error(`unexpected status ${first.status}`);

  const second = await runAgent(supportMachineStep3, {
    snapshot: first.persist(),
    event: approve ? { type: "APPROVE" } : { type: "DENY", reason: "Outside policy." },
    executors,
  });
  if (second.status !== "done") throw new Error(`unexpected status ${second.status}`);
  return second.output;
}
