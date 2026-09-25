/**
 * Declaration-emission canary (see tsconfig.json). Imports the package BY NAME
 * (resolved to the built dist/ .d.ts via package.json `exports`), builds a
 * machine with `agent.decide` + a text request, and RE-EXPORTS
 * it. Emitting `machine`'s declaration forces TS to name every type its
 * inferred type references (DecisionLogic/TextLogic and friends) — if
 * any leaked-but-unexported symbol remains, tsc raises TS4023 here.
 *
 * Run with a built dist present: `pnpm build && pnpm check:dts`.
 */
import { z } from "zod";
import { noul } from "@typesafe-ai/sdk";
import { runAgent, setupAgent } from "@statelyai/agent";
import { createSystemOneLogic } from "@statelyai/agent/typesafe";

// Something from every entry — proves each entry's public types resolve
// from the shipped package, not just source. The root block also asserts the
export {
  eventFromInteraction,
  executeAgentRequest,
  getInteraction,
  getJsonSchema,
  resolveDecision,
  runAgentStream,
  type AgentOutputMode,
  type AgentInteraction,
  type AgentTextResult,
  type ProviderStructuredOutput,
} from "@statelyai/agent";
export { createAiSdkExecutors, parseModelRef } from "@statelyai/agent/ai-sdk";
export { createToolLoopMachine, type CreateRouterMachineConfig } from "@statelyai/agent/machines";
export {
  createOtelTraceHandler,
  type OtelTraceHandler,
  type OtelTraceHandlerOptions,
} from "@statelyai/agent/otel";
export { type SystemOneLogicOptions, type SystemOneOutput } from "@statelyai/agent/typesafe";

// A System One actor's inferred type names the SDK's question and answer
// types through the shipped `typesafe` declarations.
export const judgeTopic = createSystemOneLogic({
  state: (input: { topic: string }) => ({ topic: input.topic }),
  questions: () => ({ onTopic: noul("Is `topic` about state machines?") }),
});

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

// DecisionLogic (agent.decide) + TextLogic (summarize) both leak into this
// machine's inferred type — the TS4023 surface.
export const machine = setup.createMachine({
  id: "dts-consumer",
  context: ({ input }) => ({ topic: input.topic, summary: null }),
  initial: "deciding",
  states: {
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
          context: ({ event }) => ({ summary: event.output.result }),
        },
      },
    },
    done: { type: "final" },
  },
});

export async function run() {
  return runAgent(machine, { input: { topic: "state machines" } });
}
