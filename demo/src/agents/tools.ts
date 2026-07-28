/**
 * Tools (ReAct loop) — the model reasons and acts; the machine caps the loop.
 *
 * What the MODEL owns: each turn it picks one legal event via `agent.decide` —
 * call a tool (`CALCULATE` / `LOOKUP`) or `FINISH` with an answer.
 * What the MACHINE owns: the loop and its bound. `thinking` is a choice state
 * that checks `context.steps` against `maxSteps`; at the cap it stops asking the
 * model to choose and forces a final answer (`forcedAnswer`). The tools are real
 * actors that actually compute. The classic "reason → act → observe" loop is
 * explicit states you can point at, not a hidden framework primitive.
 */
import { z } from "zod";
import { createAsyncLogic } from "xstate";
import { setupAgent } from "@statelyai/agent";

const MAX_STEPS = 4;

/** Sample knowledge base — a stand-in for a retrieval tool. */
export const KNOWLEDGE_BASE: Record<string, string> = {
  "speed of light": "299,792,458 meters per second",
  "earth radius": "6,371 kilometers (mean)",
  "seconds per day": "86,400 seconds",
  "moon distance": "384,400 kilometers (average from Earth)",
};

const calcSchema = z.object({
  operation: z.enum(["add", "subtract", "multiply", "divide"]),
  a: z.number(),
  b: z.number(),
});

const agentSetup = setupAgent({
  context: z.object({
    question: z.string(),
    steps: z.number(),
    observations: z.array(z.string()),
    pendingCalc: calcSchema.nullable(),
    pendingKey: z.string().nullable(),
    answer: z.string().nullable(),
  }),
  input: z.object({ question: z.string() }),
  output: z.object({ answer: z.string(), steps: z.number() }),
  events: {
    CALCULATE: calcSchema,
    LOOKUP: z.object({ key: z.string() }),
    FINISH: z.object({ answer: z.string() }),
  },
  // Two real tools as typed actors — they genuinely compute.
  actors: {
    calculate: createAsyncLogic<{ summary: string }, z.infer<typeof calcSchema>>({
      run: async ({ input }) => {
        const { operation, a, b } = input;
        const value =
          operation === "add"
            ? a + b
            : operation === "subtract"
              ? a - b
              : operation === "multiply"
                ? a * b
                : b === 0
                  ? NaN
                  : a / b;
        return { summary: Number.isNaN(value) ? "division by zero" : `${a} ${operation} ${b} = ${value}` };
      },
    }),
    lookup: createAsyncLogic<{ summary: string }, { key: string }>({
      run: async ({ input }) => {
        const fact = KNOWLEDGE_BASE[input.key.trim().toLowerCase()];
        return { summary: fact ? `${input.key}: ${fact}` : `No entry for "${input.key}".` };
      },
    }),
  },
  requests: {
    // Only used at the cap: compose a final answer from what was gathered.
    forceAnswer: {
      schemas: { input: z.object({ question: z.string(), observations: z.array(z.string()) }), output: z.string() },
      model: "reasoner",
      system: "Give the best final answer you can from the observations gathered so far.",
      prompt: ({ input }) =>
        `Question: ${input.question}\n\nObservations:\n${input.observations.join("\n") || "(none)"}`,
    },
  },
});

export const toolsMachine = agentSetup.createMachine({
  id: "tools",
  context: ({ input }) => ({
    question: input.question,
    steps: 0,
    observations: [],
    pendingCalc: null,
    pendingKey: null,
    answer: null,
  }),
  initial: "thinking",
  states: {
    // The loop bound, made visible: keep reasoning while budget remains, else
    // stop asking the model and force a final answer.
    thinking: {
      type: "choice",
      choice: ({ context }) =>
        context.steps >= MAX_STEPS ? { target: "forcedAnswer" } : { target: "deciding" },
    },
    deciding: {
      invoke: {
        src: "agent.decide",
        input: ({ context }) => ({
          model: "reasoner",
          system:
            "You are a ReAct agent. Each turn, either call a tool or FINISH with the answer. " +
            "Tools: CALCULATE (arithmetic), LOOKUP (retrieve a fact by key, e.g. \"speed of light\"). " +
            "Prefer answering as soon as you can.",
          prompt:
            `Question: ${context.question}\n\nObservations:\n` +
            `${context.observations.join("\n") || "(none)"}\n\nCall a tool or FINISH.`,
          allowedEvents: ["CALCULATE", "LOOKUP", "FINISH"],
        }),
      },
      on: {
        CALCULATE: {
          target: "calculating",
          context: ({ event }) => ({ pendingCalc: event }),
        },
        LOOKUP: {
          target: "lookingUp",
          context: ({ event }) => ({ pendingKey: event.key }),
        },
        FINISH: {
          target: "done",
          context: ({ event }) => ({ answer: event.answer }),
        },
      },
    },
    calculating: {
      invoke: {
        src: "calculate",
        input: ({ context }) => context.pendingCalc ?? { operation: "add" as const, a: 0, b: 0 },
        onDone: {
          target: "thinking",
          context: ({ context, output }) => ({
            steps: context.steps + 1,
            observations: [...context.observations, `Observation: ${output.summary}`],
            pendingCalc: null,
          }),
        },
      },
    },
    lookingUp: {
      invoke: {
        src: "lookup",
        input: ({ context }) => ({ key: context.pendingKey ?? "" }),
        onDone: {
          target: "thinking",
          context: ({ context, output }) => ({
            steps: context.steps + 1,
            observations: [...context.observations, `Observation: ${output.summary}`],
            pendingKey: null,
          }),
        },
      },
    },
    // Cap reached: the machine forces a final answer instead of looping forever.
    forcedAnswer: {
      invoke: {
        src: "forceAnswer",
        input: ({ context }) => ({ question: context.question, observations: context.observations }),
        onDone: { target: "done", context: ({ output }) => ({ answer: output }) },
        onError: { target: "done" },
      },
    },
    done: {
      type: "final",
      output: ({ context }) => ({
        answer: context.answer ?? "No answer produced within the step budget.",
        steps: context.steps,
      }),
    },
  },
});
