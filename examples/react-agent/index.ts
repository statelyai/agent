/**
 * ReAct agent — the classic reason-or-act loop as an EXPLICIT, visible machine.
 *
 * LangGraph: `createReactAgent(model, tools)` gives you a tool-calling agent
 * whose loop is opaque — reason → call tool → observe → repeat is hidden inside
 * the prebuilt graph. Here: the same loop as visible states you can point at.
 *   reasoning → dispatch → (calculator | lookup) → reasoning → ... → answering
 *
 * Each iteration is ONE `reasonOrAct` request. The model sees the accumulated
 * messages (question + every tool call and its result so far) and returns a
 * discriminated union: either `{ type: 'tool', ... }` (call a tool) or
 * `{ type: 'answer', ... }` (it's done). The machine reads that typed output and
 * either dispatches to a tool actor or finishes.
 *
 * Demonstrates:
 *   - The ReAct loop as states, not a black box: `reasoning` is re-entered after
 *     every tool observation — the loop edge is a real transition, not hidden
 *     iteration inside a framework primitive.
 *   - "Model calls a tool OR answers" as a discriminated-union output schema.
 *     An unknown tool name can't type-check into the union — the schema rejects
 *     it, so a hallucinated tool never reaches an actor.
 *   - 2 real local tools as typed actors that genuinely compute: a calculator
 *     and a small labeled knowledge lookup. Nothing canned.
 *   - A guarded loop: `stepsRemaining` decrements per iteration. Budget
 *     exhausted → a final state with a best-effort answer. This is the manual
 *     loop-breaker every LangGraph app hand-rolls (recursion_limit / a step
 *     counter); here it's a typed guard in a `choice` state, made visible below.
 *
 * Dual-mode: `runReactAgentExample(options?)` takes injectable executors (the
 * test passes mocks — keyless CI); the direct run below uses real models.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/react-agent/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAsyncLogic } from "xstate";
import { defineModels } from "../../src/ai-sdk/index.js";
import {
  type AgentMessage,
  assistantMessage,
  runAgent,
  setupAgent,
  userMessage,
  type AgentRequestExecutors,
} from "../../src/index.js";
import { runExampleMain } from "../helpers/main.js";

export const models = defineModels({
  reasoner: openai("gpt-5.4-mini"),
});

/** Sample data: a tiny labeled knowledge base (stand-in for a retrieval tool). */
export const KNOWLEDGE_BASE: Record<string, string> = {
  "speed of light": "299,792,458 meters per second",
  "earth radius": "6,371 kilometers (mean)",
  "seconds per day": "86,400 seconds",
  "moon distance": "384,400 kilometers (average from Earth)",
};

const toolResultSchema = z.object({
  summary: z.string(),
  value: z.number().nullable(),
});
type ToolResult = z.infer<typeof toolResultSchema>;

// "Reason or act": the model returns exactly one branch each iteration.
// A tool name that isn't in the union can't validate — a hallucinated tool
// never reaches an actor (the schema is the guard). Each branch carries a
// `tool` literal; the `answer` branch is the "I'm done" branch.
const reasonOrActUnion = z.union([
  z.object({
    type: z.literal("tool"),
    thought: z.string(),
    tool: z.literal("calculate"),
    parameters: z.object({
      operation: z.enum(["add", "subtract", "multiply", "divide"]),
      a: z.number(),
      b: z.number(),
    }),
  }),
  z.object({
    type: z.literal("tool"),
    thought: z.string(),
    tool: z.literal("lookup"),
    parameters: z.object({ key: z.string() }),
  }),
  z.object({
    type: z.literal("answer"),
    thought: z.string(),
    tool: z.literal("answer"),
    answer: z.string(),
  }),
]);
type ReasonOrAct = z.infer<typeof reasonOrActUnion>;

// The request output is object-wrapped: a bare union serializes to a JSON
// Schema with no top-level `type: "object"` (so the structured-output detector
// would treat it as plain text), and OpenAI structured output rejects the
// `oneOf` that `z.discriminatedUnion` emits while accepting a plain `z.union`'s
// `anyOf`. The machine unwraps `.action` back into a union value.
const reasonOrActSchema = z.object({ action: reasonOrActUnion });

const agentSetup = setupAgent({
  models,
  context: z.object({
    question: z.string(),
    // Accumulating transcript: question + each tool call and its observation.
    messages: z.custom<AgentMessage[]>((value) => Array.isArray(value)),
    stepsRemaining: z.number(),
    // The model's latest reason-or-act decision (drives dispatch).
    next: z.custom<ReasonOrAct>().nullable(),
    answer: z.string().nullable(),
  }),
  input: z.object({
    question: z.string(),
    maxSteps: z.number().default(5),
  }),
  output: z.object({
    answer: z.string(),
    steps: z.number(),
  }),
  actorSources: {
    // Real calculator — actually computes.
    calculate: createAsyncLogic<
      ToolResult,
      {
        operation: "add" | "subtract" | "multiply" | "divide";
        a: number;
        b: number;
      }
    >({
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
        return {
          summary: `${a} ${operation} ${b} = ${value}`,
          value: Number.isNaN(value) ? null : value,
        };
      },
    }),
    // Real knowledge lookup — reads the labeled table, genuinely retrieves.
    lookup: createAsyncLogic<ToolResult, { key: string }>({
      run: async ({ input }) => {
        const key = input.key.trim().toLowerCase();
        const fact = KNOWLEDGE_BASE[key];
        return fact === undefined
          ? { summary: `No entry for "${input.key}".`, value: null }
          : { summary: `${input.key}: ${fact}`, value: null };
      },
    }),
  },
  requests: {
    // One iteration of the ReAct loop: read the transcript, either call a tool
    // or produce the final answer.
    reasonOrAct: {
      schemas: {
        input: z.object({
          messages: z.custom<AgentMessage[]>((value) => Array.isArray(value)),
          stepsRemaining: z.number(),
        }),
        output: reasonOrActSchema,
      },
      model: "reasoner",
      system:
        "You are a ReAct agent. Reason step by step. Each turn, either call one " +
        "tool to gather what you need, or give the final answer once you have " +
        "enough. Tools: calculate (arithmetic: add/subtract/multiply/divide), " +
        'lookup (retrieve a fact by key, e.g. "speed of light", "seconds per day"). ' +
        "Prefer answering as soon as you can; you have a limited step budget. " +
        "Put your decision in the `action` field.",
      messages: ({ input }) => [
        ...input.messages,
        userMessage(
          `Steps remaining: ${input.stepsRemaining}. ` + "Call a tool or give the final answer.",
        ),
      ],
    },
  },
});

export const reactAgentSchemas = agentSetup.schemas;

export const reactAgentMachine = agentSetup.createMachine({
  id: "react-agent",
  context: ({ input }) => ({
    question: input.question,
    messages: [userMessage(input.question)],
    stepsRemaining: input.maxSteps,
    next: null,
    answer: null,
  }),
  // Single source of the done result. `context.answer` is set when the model
  // answers; if the loop is broken by the budget guard instead, fall back to
  // the last thing the model said (best-effort).
  output: ({ context }) => {
    if (context.answer !== null) {
      return {
        answer: context.answer,
        steps: context.messages.filter((m) => m.role === "assistant").length,
      };
    }
    const lastAssistant = [...context.messages].reverse().find((m) => m.role === "assistant");
    return {
      answer:
        typeof lastAssistant?.content === "string"
          ? lastAssistant.content
          : "Step budget exhausted before reaching a confident answer.",
      steps: context.messages.filter((m) => m.role === "assistant").length,
    };
  },
  initial: "checkingBudget",
  states: {
    // The guarded loop-breaker every LangGraph app hand-rolls (recursion_limit /
    // a manual step counter) — here it's a typed guard in an explicit state.
    // Budget exhausted → give up gracefully with a best-effort answer.
    checkingBudget: {
      type: "choice",
      choice: ({ context }) =>
        context.stepsRemaining > 0 ? { target: "reasoning" } : { target: "exhausted" },
    },
    // One turn of the loop: the model reasons and either acts or answers.
    reasoning: {
      invoke: {
        id: "reasonOrAct",
        src: "reasonOrAct",
        input: ({ context }) => ({
          messages: context.messages,
          stepsRemaining: context.stepsRemaining,
        }),
        onDone: ({ context, output }) => ({
          target: "dispatch",
          context: {
            next: output.action,
            // Commit the final answer to context when the model is done.
            answer: output.action.type === "answer" ? output.action.answer : context.answer,
            // Record the model's move in the transcript.
            messages: [
              ...context.messages,
              assistantMessage(
                output.action.type === "answer"
                  ? output.action.answer
                  : `${output.action.thought}\n[calling ${output.action.tool}]`,
              ),
            ],
            // Decrement the budget once per model turn.
            stepsRemaining: context.stepsRemaining - 1,
          },
        }),
      },
    },
    // Read the typed decision: answer → finish, tool → dispatch to that actor.
    dispatch: {
      type: "choice",
      choice: ({ context }) =>
        context.next?.type === "answer"
          ? { target: "answered" }
          : context.next?.tool === "calculate"
            ? { target: "calculating" }
            : { target: "lookingUp" },
    },
    calculating: {
      invoke: {
        src: "calculate",
        input: ({ context }) =>
          context.next?.type === "tool" && context.next.tool === "calculate"
            ? context.next.parameters
            : { operation: "add" as const, a: 0, b: 0 },
        onDone: ({ context, output }) => ({
          // Loop edge: observe the tool result, then re-enter the loop.
          target: "checkingBudget",
          context: {
            messages: [...context.messages, userMessage(`Observation: ${output.summary}`)],
          },
        }),
      },
    },
    lookingUp: {
      invoke: {
        src: "lookup",
        input: ({ context }) =>
          context.next?.type === "tool" && context.next.tool === "lookup"
            ? context.next.parameters
            : { key: "" },
        onDone: ({ context, output }) => ({
          target: "checkingBudget",
          context: {
            messages: [...context.messages, userMessage(`Observation: ${output.summary}`)],
          },
        }),
      },
    },
    // The model committed to an answer (in context) — done.
    answered: { type: "final" },
    // Budget ran out before the model answered — done with a best-effort
    // answer, resolved by the machine `output` getter above (no throw).
    exhausted: { type: "final" },
  },
});

export interface RunReactAgentOptions {
  question?: string;
  maxSteps?: number;
  /** Injected for tests; direct run supplies a real model executor. */
  generateText?: AgentRequestExecutors["generateText"];
  /** Observes each machine transition (the visible loop). */
  onProgress?: (state: string) => void;
}

export interface ReactAgentResult {
  answer: string;
  steps: number;
  progress: string[];
}

/** Runs the ReAct loop; records state progress so the loop is observable. */
export async function runReactAgentExample(
  options: RunReactAgentOptions = {},
): Promise<ReactAgentResult> {
  const {
    question = "How many seconds are there in 3 days?",
    maxSteps = 5,
    generateText,
    onProgress,
  } = options;

  const progress: string[] = [];
  const result = await runAgent(reactAgentMachine, {
    input: { question, maxSteps },
    ...(generateText ? { generateText } : {}),
    onTransition: (snapshot) => {
      const state = String(snapshot.value);
      progress.push(state);
      onProgress?.(state);
    },
  });

  if (result.status !== "done") {
    throw new Error(`React-agent example did not complete: ${result.status}`);
  }
  return { ...result.output, progress };
}

runExampleMain(import.meta.url, async () => {
  const { createAiSdkExecutors } = await import("../../src/ai-sdk/index.js");
  const { generateText } = createAiSdkExecutors({ models });

  const question = "How many seconds are there in 3 days?";
  const result = await runReactAgentExample({
    question,
    generateText,
    onProgress: (state) => console.log(`  → ${state}`),
  });

  console.log("Question:", question);
  console.log("Answer:", result.answer);
  console.log("Steps:", result.steps);
});
