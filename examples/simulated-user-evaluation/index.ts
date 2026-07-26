/**
 * Simulated-user evaluation — a target chatbot and a user persona alternate
 * until the persona finishes or a turn budget is reached, then a separate judge
 * scores the transcript.
 *
 * This ports LangGraph's multi-agent simulation topology without LangSmith's
 * dataset, experiment, or hosted runtime layers.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/simulated-user-evaluation/index.ts
 */
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { runAgent, setupAgent, type AgentRequestExecutors } from "@statelyai/agent";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";

const messageSchema = z.object({ role: z.enum(["user", "assistant"]), content: z.string() });

export const models = defineModels({
  chatbot: openai("gpt-5.4-mini"),
  simulatedUser: openai("gpt-5.4-mini"),
  evaluator: openai("gpt-5.4-mini"),
});

const setup = setupAgent({
  models,
  context: z.object({
    scenario: z.string(),
    transcript: z.array(messageSchema),
    turn: z.number(),
    maxTurns: z.number(),
    finished: z.boolean(),
    score: z.number().nullable(),
    feedback: z.string().nullable(),
  }),
  input: z.object({ scenario: z.string(), opening: z.string(), maxTurns: z.number().default(4) }),
  output: z.object({ transcript: z.array(messageSchema), score: z.number(), feedback: z.string() }),
  requests: {
    chatbot: {
      schemas: {
        input: z.object({ scenario: z.string(), transcript: z.array(messageSchema) }),
        output: z.string(),
      },
      model: "chatbot",
      system: "You are the support chatbot under evaluation. Be accurate, direct, and helpful.",
      prompt: ({ input }) => `${input.scenario}\n\n${JSON.stringify(input.transcript)}`,
    },
    simulatedUser: {
      schemas: {
        input: z.object({ scenario: z.string(), transcript: z.array(messageSchema) }),
        output: z.object({ message: z.string(), finished: z.boolean() }),
      },
      model: "simulatedUser",
      system:
        "Act as the user in the scenario. Continue realistically. Set finished when the goal is met or clearly cannot be met.",
      prompt: ({ input }) => `${input.scenario}\n\n${JSON.stringify(input.transcript)}`,
    },
    evaluate: {
      schemas: {
        input: z.object({ scenario: z.string(), transcript: z.array(messageSchema) }),
        output: z.object({ score: z.number().min(0).max(5), feedback: z.string() }),
      },
      model: "evaluator",
      system: "Score the chatbot from 0-5 for task completion, correctness, and communication.",
      prompt: ({ input }) => `${input.scenario}\n\n${JSON.stringify(input.transcript)}`,
    },
  },
});

export const simulatedUserEvaluationMachine = setup.createMachine({
  id: "simulated-user-evaluation",
  context: ({ input }) => ({
    scenario: input.scenario,
    transcript: [{ role: "user" as const, content: input.opening }],
    turn: 0,
    maxTurns: input.maxTurns,
    finished: false,
    score: null,
    feedback: null,
  }),
  output: ({ context }) => ({
    transcript: context.transcript,
    score: context.score ?? 0,
    feedback: context.feedback ?? "",
  }),
  initial: "chatbot",
  states: {
    chatbot: {
      invoke: {
        src: "chatbot",
        input: ({ context }) => ({ scenario: context.scenario, transcript: context.transcript }),
        onDone: ({ output, context }) => ({
          target: "simulatedUser",
          context: {
            transcript: [...context.transcript, { role: "assistant" as const, content: output }],
          },
        }),
      },
    },
    simulatedUser: {
      invoke: {
        src: "simulatedUser",
        input: ({ context }) => ({ scenario: context.scenario, transcript: context.transcript }),
        onDone: ({ output, context }) => ({
          target:
            output.finished || context.turn + 1 >= context.maxTurns ? "evaluating" : "chatbot",
          context: {
            transcript: [...context.transcript, { role: "user" as const, content: output.message }],
            finished: output.finished,
            turn: context.turn + 1,
          },
        }),
      },
    },
    evaluating: {
      invoke: {
        src: "evaluate",
        input: ({ context }) => ({ scenario: context.scenario, transcript: context.transcript }),
        onDone: ({ output }) => ({
          target: "done",
          context: { score: output.score, feedback: output.feedback },
        }),
      },
    },
    done: { type: "final" },
  },
});

export interface RunSimulatedUserEvaluationOptions {
  scenario?: string;
  opening?: string;
  maxTurns?: number;
  /** Injected for tests; direct run supplies a real model executor. */
  generateText?: AgentRequestExecutors["generateText"];
  /** Observes each machine transition. */
  onProgress?: (state: string) => void;
}

export async function runSimulatedUserEvaluationExample(
  options: RunSimulatedUserEvaluationOptions = {},
) {
  const {
    scenario = "The user needs to change the delivery address before an order ships.",
    opening = "I entered the wrong address. Can you help?",
    maxTurns = 4,
    generateText,
    onProgress,
  } = options;
  const result = await runAgent(simulatedUserEvaluationMachine, {
    input: { scenario, opening, maxTurns },
    ...(generateText
      ? { executors: { generateText } }
      : { executors: createAiSdkExecutors({ models }) }),
    ...(onProgress ? { onTransition: (snapshot) => onProgress(String(snapshot.value)) } : {}),
  });
  if (result.status !== "done") throw new Error(`Simulation did not complete: ${result.status}`);
  return result.output;
}

if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) throw new Error("Set OPENAI_API_KEY to run this example.");
  void runSimulatedUserEvaluationExample().then(console.log);
}
