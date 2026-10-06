/**
 * A model drafts a proposal, then waits for approval with a deadline. The
 * deadline is a plain XState `after` timer; where it lives is the host's call:
 *
 *   - In-process (the default): the loop counts the armed timer as work in
 *     flight and keeps reading until it fires — fine for a script.
 *   - Host-owned (`timers: { schedule, cancel }`): the run settles as soon as
 *     nothing else is in flight, the host puts the timer in its own durable
 *     scheduler (a Temporal timer, a Durable Object alarm, an Inngest sleep),
 *     and when it fires, delivers `{ type: "xstate.timer", id }` to a resumed
 *     run. No in-process wait has to survive the suspension.
 *
 * Approval and expiry race inside the machine: whichever is delivered first
 * wins, and the other is ignored. A stale approval (another request's id)
 * never passes the guard.
 * Inspired by https://docs.langchain.com/oss/javascript/langgraph/interrupts
 * Pass `executors` to swap the model layer; tests script it by request name.
 * Run: OPENAI_API_KEY=... pnpm tsx examples/deadline-escalation/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import {
  interactionMetaSchema,
  createAgentRuntime,
  runToQuiescence,
  setupAgent,
  type AgentRuntimeOptions,
  type AgentRunInit,
} from "@statelyai/agent";

/** The request this example's approval UI is rendered for. */
export const REQUEST_ID = "proposal-1";

const input = z.object({
  requestId: z.string(),
  task: z.string(),
  /** How long the approver has, from the moment the draft is ready. */
  windowMs: z.number().int().nonnegative(),
});
const models = {
  writer: openai("gpt-5.4-mini"),
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
  events: { APPROVE: z.object({ requestId: z.string() }) },
  delays: { approvalWindow: ({ context }) => context.windowMs },
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
          label: "Approve the proposal before the approval window closes.",
          // The approve button is rendered for one request: its id is fixed
          // here, so a host sends a bare APPROVE and the id rides along. An
          // approval carrying any other id is stale and fails the guard.
          events: { APPROVE: { label: "Approve proposal", event: { requestId: REQUEST_ID } } },
        },
      },
      after: { approvalWindow: { target: "escalated" } },
      on: {
        APPROVE: ({ context, event }) =>
          event.requestId === context.requestId ? { target: "approved" } : undefined,
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
  options?: AgentRuntimeOptions<typeof deadlineEscalationMachine> &
    AgentRunInit<typeof deadlineEscalationMachine>,
) {
  const { executors = liveExecutors(), ...runOptions } = options ?? {};
  return runToQuiescence(
    createAgentRuntime(deadlineEscalationMachine, {
      ...runOptions,
      executors,
    }),
    {
      input: { requestId: REQUEST_ID, task: "Schedule a maintenance window", windowMs: 60_000 },
      ...runOptions,
    },
  );
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  void (async () => {
    // A stand-in for a durable scheduler: it only records what to fire.
    const scheduled = new Map<string, number>();
    const timers = {
      schedule: ({ id, delay }: { id: string; delay: number }) => scheduled.set(id, delay),
      cancel: (id: string) => scheduled.delete(id),
    };
    const pending = await runDeadlineEscalationExample({ timers });
    if (pending.status !== "idle") throw new Error(`Expected approval wait, got ${pending.status}`);
    const [id, delay] = [...scheduled][0]!;
    console.log(`Approval window scheduled: fires in ${delay}ms (timer ${id}).`);
    // Nobody approves; the scheduler fires into a fresh-process JSON restore.
    const result = await runDeadlineEscalationExample({
      timers,
      snapshot: JSON.parse(JSON.stringify(pending.persist())),
      event: { type: "xstate.timer", id },
    });
    console.log(result.status === "done" ? result.output : result.status);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
