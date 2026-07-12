/**
 * Tool calling: the model selects a tool (structured output), a typed tool
 * actor genuinely executes it, progress is surfaced via `onTransition`, and a
 * final request formats the result into a human answer.
 *
 * Demonstrates:
 *   - Tool selection as structured-output classification (`selectTool` returns
 *     one branch of a discriminated union) — not an event-choice decision. There
 *     is exactly one live path forward, chosen by inspecting the typed output.
 *   - Three real local tools as typed actors that actually compute:
 *     a calculator, a unit converter, and a (sample-data) currency lookup.
 *     Nothing is canned — the actors run genuine logic.
 *   - Progress surfaced host-side via `onTransition`: each machine state change
 *     is observed from the typed snapshot (no custom streaming layer).
 *   - A final `formatResult` request that turns the raw tool output into prose.
 *
 * The `generateText` executor is injectable so tests can drive the machine with
 * a mock; on direct run it uses a real model.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/tool-calling/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAsyncLogic } from "xstate";
import { defineModels } from "../../src/ai-sdk/index.js";
import { runAgent, setupAgent, type AgentRequestExecutors } from "../../src/index.js";
import { runExampleMain } from "../helpers/main.js";

export const models = defineModels({
  router: openai("gpt-5.4-mini"),
  formatter: openai("gpt-5.4-mini"),
});

/** Sample data: a tiny fixed exchange-rate table (stand-in for a rates API). */
export const SAMPLE_RATES: Record<string, number> = {
  "USD->EUR": 0.92,
  "EUR->USD": 1.09,
  "USD->GBP": 0.79,
  "GBP->USD": 1.27,
};

const selectedToolUnion = z.union([
  z.object({
    tool: z.literal("calculate"),
    parameters: z.object({
      operation: z.enum(["add", "subtract", "multiply", "divide"]),
      a: z.number(),
      b: z.number(),
    }),
  }),
  z.object({
    tool: z.literal("convertUnits"),
    parameters: z.object({
      value: z.number(),
      from: z.enum(["km", "mi"]),
      to: z.enum(["km", "mi"]),
    }),
  }),
  z.object({
    tool: z.literal("lookupRate"),
    parameters: z.object({
      from: z.string(),
      to: z.string(),
    }),
  }),
]);

// The request output is object-wrapped for two reasons: a bare union serializes
// to a JSON Schema with no top-level `type: "object"`, so the executor's
// structured-output detection would misclassify it as plain text; and OpenAI's
// structured output rejects `oneOf` (what `z.discriminatedUnion` emits) but
// accepts the `anyOf` a plain `z.union` emits. The wrapper gives the schema a
// top-level object type; the machine unwraps `.selected` back into a union.
const selectedToolSchema = z.object({ selected: selectedToolUnion });

const toolResultSchema = z.object({
  summary: z.string(),
  value: z.number().nullable(),
});
type ToolResult = z.infer<typeof toolResultSchema>;

const toolCallingContextSchema = z.object({
  query: z.string(),
  selected: selectedToolUnion.nullable(),
  result: toolResultSchema.nullable(),
  finalAnswer: z.string().nullable(),
});

const agentSetup = setupAgent({
  models,
  context: toolCallingContextSchema,
  input: z.object({ query: z.string() }),
  output: z.object({
    tool: z.string(),
    result: toolResultSchema,
    finalAnswer: z.string(),
  }),
  // selectingTool sets `selected`, and whichever tool state runs sets `result`,
  // before formatting sets `finalAnswer` — all guaranteed non-null by `done`.
  states: {
    selectingTool: {},
    // Narrowing threads the chain: selected is set entering dispatch, result
    // entering formatting, finalAnswer entering done.
    dispatch: {
      schemas: { context: toolCallingContextSchema.extend({ selected: selectedToolUnion }) },
    },
    calculating: {
      schemas: { context: toolCallingContextSchema.extend({ selected: selectedToolUnion }) },
    },
    converting: {
      schemas: { context: toolCallingContextSchema.extend({ selected: selectedToolUnion }) },
    },
    lookingUp: {
      schemas: { context: toolCallingContextSchema.extend({ selected: selectedToolUnion }) },
    },
    formatting: {
      schemas: {
        context: toolCallingContextSchema.extend({
          selected: selectedToolUnion,
          result: toolResultSchema,
        }),
      },
    },
    done: {
      schemas: {
        context: toolCallingContextSchema.extend({
          selected: selectedToolUnion,
          result: toolResultSchema,
          finalAnswer: z.string(),
        }),
      },
    },
  },
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
    // Real unit converter — km <-> mi.
    convertUnits: createAsyncLogic<
      ToolResult,
      { value: number; from: "km" | "mi"; to: "km" | "mi" }
    >({
      run: async ({ input }) => {
        const { value, from, to } = input;
        const converted = from === to ? value : from === "km" ? value / 1.609344 : value * 1.609344;
        const rounded = Math.round(converted * 1000) / 1000;
        return {
          summary: `${value} ${from} = ${rounded} ${to}`,
          value: rounded,
        };
      },
    }),
    // Sample-data lookup — reads the fixed rate table, genuinely computes.
    lookupRate: createAsyncLogic<ToolResult, { from: string; to: string }>({
      run: async ({ input }) => {
        const key = `${input.from.toUpperCase()}->${input.to.toUpperCase()}`;
        const rate = SAMPLE_RATES[key];
        return rate === undefined
          ? { summary: `No sample rate for ${key}.`, value: null }
          : {
              summary: `1 ${input.from.toUpperCase()} = ${rate} ${input.to.toUpperCase()}`,
              value: rate,
            };
      },
    }),
  },
  requests: {
    selectTool: {
      schemas: {
        input: z.object({ query: z.string() }),
        output: selectedToolSchema,
      },
      model: "router",
      system:
        "Select exactly one tool to answer the user query, with its parameters, " +
        "in the `selected` field. Use calculate for arithmetic, convertUnits " +
        "for km/mi distances, lookupRate for currency exchange rates.",
      prompt: ({ input }) => input.query,
    },
    formatResult: {
      schemas: {
        input: z.object({
          query: z.string(),
          summary: z.string(),
        }),
        output: z.string(),
      },
      model: "formatter",
      system: "Write one friendly sentence answering the user, using the tool result.",
      prompt: ({ input }) => `Question: ${input.query}\nTool result: ${input.summary}`,
    },
  },
});

export const toolCallingMachine = agentSetup.createMachine({
  id: "tool-calling",
  context: ({ input }) => ({
    query: input.query,
    selected: null,
    result: null,
    finalAnswer: null,
  }),
  initial: "selectingTool",
  states: {
    selectingTool: {
      invoke: {
        src: "selectTool",
        input: ({ context }) => ({ query: context.query }),
        onDone: ({ output }) => ({
          target: "dispatch",
          context: { selected: output.selected },
        }),
      },
    },
    dispatch: {
      type: "choice",
      choice: ({ context }) =>
        context.selected?.tool === "calculate"
          ? { target: "calculating" }
          : context.selected?.tool === "convertUnits"
            ? { target: "converting" }
            : { target: "lookingUp" },
    },
    calculating: {
      invoke: {
        src: "calculate",
        input: ({ context }) =>
          context.selected?.tool === "calculate"
            ? context.selected.parameters
            : { operation: "add" as const, a: 0, b: 0 },
        onDone: ({ output }) => ({
          target: "formatting",
          context: { result: output },
        }),
      },
    },
    converting: {
      invoke: {
        src: "convertUnits",
        input: ({ context }) =>
          context.selected?.tool === "convertUnits"
            ? context.selected.parameters
            : { value: 0, from: "km" as const, to: "mi" as const },
        onDone: ({ output }) => ({
          target: "formatting",
          context: { result: output },
        }),
      },
    },
    lookingUp: {
      invoke: {
        src: "lookupRate",
        input: ({ context }) =>
          context.selected?.tool === "lookupRate"
            ? context.selected.parameters
            : { from: "USD", to: "EUR" },
        onDone: ({ output }) => ({
          target: "formatting",
          context: { result: output },
        }),
      },
    },
    formatting: {
      invoke: {
        src: "formatResult",
        input: ({ context }) => ({
          query: context.query,
          summary: context.result?.summary ?? "",
        }),
        onDone: ({ output }) => ({
          target: "done",
          context: { finalAnswer: output },
        }),
      },
    },
    done: {
      type: "final",
      output: ({ context }) => ({
        tool: context.selected.tool,
        result: context.result,
        finalAnswer: context.finalAnswer,
      }),
    },
  },
});

export interface RunToolCallingOptions {
  query?: string;
  /** Injected for tests; direct run supplies a real model executor. */
  generateText?: AgentRequestExecutors["generateText"];
  /** Observes each machine transition (progress). */
  onProgress?: (state: string) => void;
}

export interface ToolCallingResult {
  tool: string;
  result: ToolResult;
  finalAnswer: string;
  progress: string[];
}

/** Selects a tool, executes it, formats the answer; records state progress. */
export async function runToolCallingExample(
  options: RunToolCallingOptions = {},
): Promise<ToolCallingResult> {
  const { query = "What is 42 times 17?", generateText, onProgress } = options;

  const progress: string[] = [];
  const result = await runAgent(toolCallingMachine, {
    input: { query },
    ...(generateText ? { generateText } : {}),
    onTransition: (snapshot) => {
      const state = String(snapshot.value);
      progress.push(state);
      onProgress?.(state);
    },
  });

  if (result.status !== "done") {
    throw new Error(`Tool-calling example did not complete: ${result.status}`);
  }
  return { ...result.output, progress };
}

runExampleMain(import.meta.url, async () => {
  const { createAiSdkExecutors } = await import("../../src/ai-sdk/index.js");
  const { generateText } = createAiSdkExecutors({ models });

  const query = "How many miles is 10 kilometers?";
  const result = await runToolCallingExample({
    query,
    generateText,
    onProgress: (state) => console.log(`  → ${state}`),
  });

  console.log("Query:", query);
  console.log("Selected tool:", result.tool);
  console.log("Tool result:", result.result.summary);
  console.log("Answer:", result.finalAnswer);
});
