/**
 * A model drafts a proposal. A host schedules a correlated EXPIRE event;
 * the machine owns which approval/expiry wins. No in-process timer survives
 * suspension: persist the idle checkpoint before scheduling delivery. The host
 * serializes deliveries (or uses compare-and-swap) and retries early deliveries;
 * independent resumes of the same snapshot do not provide mutual exclusion.
 * Inspired by https://docs.langchain.com/oss/javascript/langgraph/interrupts
 * The draft is a real model call; the clock and scheduler stay host-owned
 * (the CLI simulates one expiry delivery). Pass `executors` to swap the model
 * layer; tests script it by request name.
 * Run: OPENAI_API_KEY=... pnpm tsx examples/deadline-escalation/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import {
  interactionMetaSchema,
  runAgent,
  setupAgent,
  type RunAgentOptions,
} from "@statelyai/agent";

const input = z.object({ requestId: z.string(), task: z.string(), deadline: z.number().finite() });
const delivery = z.object({ requestId: z.string(), observedAt: z.number().finite() });
const models = {
  writer: openai("gpt-6-luna"),
};
const agent = setupAgent({
  models,
  input,
  context: input.extend({ proposal: z.string().nullable() }),
  output: z.object({
    outcome: z.enum(["approved", "escalated", "failed"]),
    proposal: z.string().nullable(),
  }),
  meta: interactionMetaSchema,
  events: { APPROVE: delivery, EXPIRE: delivery },
  requests: {
    propose: {
      schemas: { input: z.object({ task: z.string() }), output: z.string() },
      model: "writer",
      prompt: ({ input }) => `Draft a proposal: ${input.task}`,
    },
  },
});

export const deadlineEscalationMachine = agent.createMachine({
  id: "deadline-escalation",
  context: ({ input }) => ({ ...input, proposal: null }),
  initial: "drafting",
  states: {
    drafting: {
      invoke: {
        src: "propose",
        input: ({ context }) => ({ task: context.task }),
        onDone: ({ output }) => ({
          target: "awaitingApproval",
          context: { proposal: output.result },
        }),
        onError: { target: "failed" },
      },
    },
    awaitingApproval: {
      meta: {
        interaction: {
          label: "Approve the proposal before the host-owned deadline, or let it expire.",
          events: {
            APPROVE: { label: "Approve proposal" },
            EXPIRE: { label: "Deadline reached" },
          },
        },
      },
      // The authenticated host supplies timestamps and correlates deliveries;
      // never accept client-supplied observedAt as a trusted clock.
      on: {
        APPROVE: ({ context, event }) =>
          event.requestId === context.requestId && event.observedAt < context.deadline
            ? { target: "approved" }
            : undefined,
        EXPIRE: ({ context, event }) =>
          event.requestId === context.requestId && event.observedAt >= context.deadline
            ? { target: "escalated" }
            : undefined,
      },
    },
    approved: {
      type: "final",
      output: ({ context }) => ({ outcome: "approved", proposal: context.proposal }),
    },
    escalated: {
      type: "final",
      output: ({ context }) => ({ outcome: "escalated", proposal: context.proposal }),
    },
    failed: {
      type: "final",
      output: ({ context }) => ({ outcome: "failed", proposal: context.proposal }),
    },
  },
});

/** The host's real executors: one OpenAI model behind the `writer` ref. */
function liveExecutors() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Set OPENAI_API_KEY to run the deadline-escalation example.");
  }
  return createAiSdkExecutors({ models });
}

export async function runDeadlineEscalationExample(
  options?: RunAgentOptions<typeof deadlineEscalationMachine>,
) {
  const { executors = liveExecutors(), ...runOptions } = options ?? {};
  return runAgent(deadlineEscalationMachine, {
    input: { requestId: "proposal-1", task: "Schedule a maintenance window", deadline: 1000 },
    ...runOptions,
    executors,
  });
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  void (async () => {
    const pending = await runDeadlineEscalationExample();
    if (pending.status !== "idle") throw new Error(`Expected approval wait, got ${pending.status}`);
    // Simulate durable scheduler delivery after a fresh-process JSON restore.
    const result = await runDeadlineEscalationExample({
      snapshot: JSON.parse(JSON.stringify(pending.persist())),
      event: { type: "EXPIRE", requestId: "proposal-1", observedAt: 1000 },
    });
    console.log(result.status === "done" ? result.output : result.status);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
