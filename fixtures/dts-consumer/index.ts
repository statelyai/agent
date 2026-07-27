/**
 * Declaration-emission canary (see tsconfig.json). Imports the package BY NAME
 * (resolved to the built dist/ .d.ts via package.json `exports`), builds a
 * machine with `agent.plan` + `agent.decide` + a text request, and RE-EXPORTS
 * it. Emitting `machine`'s declaration forces TS to name every type its
 * inferred type references (PlanLogic/DecisionLogic/TextLogic and friends) — if
 * any leaked-but-unexported symbol remains, tsc raises TS4023 here.
 *
 * Run with a built dist present: `pnpm build && pnpm check:dts`.
 */
import { z } from "zod";
import { runAgent, setupAgent } from "@statelyai/agent";

// Something from every subpath — proves each entry's public types resolve
// from the shipped package, not just source.
export {
  getAgentEffects,
  replay,
  resolveDecision,
  type AgentEffect,
  type ReplayResult,
} from "@statelyai/agent/steps";
export {
  getJsonSchema,
  parseModelRef,
  type AgentOutputMode,
  type StructuredOutputEnvelope,
} from "@statelyai/agent/adapter";
export { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
export { createOpenAiCompatExecutors } from "@statelyai/agent/openai-compat";
export { zodAgentMessages } from "@statelyai/agent/zod";

const setup = setupAgent({
  models: { quick: "openai/gpt-5.4-mini" },
  context: z.object({ topic: z.string(), summary: z.string().nullable() }),
  input: z.object({ topic: z.string() }),
  events: {
    KEEP: z.object({}),
    DROP: z.object({}),
  },
  requests: {
    summarize: {
      schemas: { input: z.object({ topic: z.string() }), output: z.string() },
      model: "quick",
      prompt: ({ input }) => `Summarize ${input.topic}.`,
    },
  },
});

// PlanLogic (agent.plan) + DecisionLogic (agent.decide) + TextLogic (summarize)
// all leak into this machine's inferred type — the TS4023 surface.
export const machine = setup.createMachine({
  id: "dts-consumer",
  context: ({ input }) => ({ topic: input.topic, summary: null }),
  initial: "planning",
  states: {
    planning: {
      invoke: {
        src: "agent.plan",
        input: ({ context }) => ({
          model: "quick" as const,
          prompt: `Manage: ${context.topic}`,
          maxSteps: 4,
        }),
        onDone: { target: "deciding" },
      },
    },
    deciding: {
      invoke: {
        src: "agent.decide",
        input: ({ context }) => ({
          model: "quick" as const,
          prompt: `Decide for ${context.topic}`,
        }),
      },
      on: {
        KEEP: { target: "summarizing" },
        DROP: { target: "done" },
      },
    },
    summarizing: {
      invoke: {
        src: "summarize",
        input: ({ context }) => ({ topic: context.topic }),
        onDone: {
          target: "done",
          context: ({ event }) => ({ summary: event.output }),
        },
      },
    },
    done: { type: "final" },
  },
});

export async function run() {
  return runAgent(machine, { input: { topic: "state machines" } });
}
