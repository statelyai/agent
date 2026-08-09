/**
 * Simulated-user evaluation — a target chatbot and a user persona alternate
 * until the persona finishes or a turn budget is reached, then a separate judge
 * scores the transcript.
 *
 * This ports LangGraph's multi-agent simulation topology without LangSmith's
 * dataset, experiment, or hosted runtime layers.
 *
 * The bot under evaluation is configurable via `playbook`: empty is the bare bot
 * (a failure baseline), and `SUPPORT_PLAYBOOK` is a bot equipped to resolve the
 * scenario (a passing baseline). Running both makes the score comparable.
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

/**
 * A passing baseline for the bot under evaluation. The bare bot (empty
 * playbook) has no product knowledge and scores badly — a useful failure case,
 * but only meaningful next to a bot that can actually do the job. Starters pair
 * the same scenario with and without this playbook so the two scores compare.
 */
export const SUPPORT_PLAYBOOK = [
  "You have access to this support playbook and must follow it:",
  "- Delayed orders: apologise, confirm the order number, and offer either a full refund or free expedited reshipment. Refunds settle in 5-7 business days.",
  "- Plans: Pro is $24/month and adds unlimited projects, priority support, and SSO. Upgrades are prorated and take effect immediately.",
  "- Price increases: the annual adjustment is $12/month; offer the annual plan (two months free) before processing any cancellation.",
  "- Address changes: possible any time before the order ships; confirm the order number, then the new address.",
  "Always resolve the request in the conversation. Never tell the user to contact support elsewhere.",
].join("\n");

const setup = setupAgent({
  models,
  context: z.object({
    scenario: z.string(),
    playbook: z.string(),
    transcript: z.array(messageSchema),
    turn: z.number(),
    maxTurns: z.number(),
    finished: z.boolean(),
    score: z.number().nullable(),
    feedback: z.string().nullable(),
  }),
  input: z.object({
    scenario: z.string(),
    opening: z.string(),
    maxTurns: z.number().default(4),
    /** Extra instructions for the bot under evaluation. Empty = the bare bot. */
    playbook: z.string().default(""),
  }),
  output: z.object({ transcript: z.array(messageSchema), score: z.number(), feedback: z.string() }),
  requests: {
    chatbot: {
      schemas: {
        input: z.object({
          scenario: z.string(),
          playbook: z.string(),
          transcript: z.array(messageSchema),
        }),
        output: z.string(),
      },
      model: "chatbot",
      // With a playbook the bot has something to answer from (the passing
      // baseline); without one it is the bare bot that scores badly.
      system: ({ input }) =>
        "You are the support chatbot under evaluation. Be accurate, direct, and helpful." +
        (input.playbook ? `\n\n${input.playbook}` : ""),
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
    playbook: input.playbook,
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
        input: ({ context }) => ({
          scenario: context.scenario,
          playbook: context.playbook,
          transcript: context.transcript,
        }),
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
  /** Extra instructions for the bot under evaluation; "" is the bare bot. */
  playbook?: string;
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
    playbook = "",
    generateText,
    onProgress,
  } = options;
  const result = await runAgent(simulatedUserEvaluationMachine, {
    input: { scenario, opening, maxTurns, playbook },
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
