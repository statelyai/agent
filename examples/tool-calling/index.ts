/**
 * Tool calling: tools are part of the request, not machine states.
 * This is the DEFAULT pattern for tool use — start here, not at react-agent.
 *
 * Tools are whatever your SDK produces. Here each tool is a native AI SDK
 * `tool({...})` — with a `description`, a Zod `inputSchema`, and a typed
 * `execute(input)` — dropped straight into `tools:`; the SDK owns the input
 * typing, so no cast is needed in the tool body. (A plain
 * `{ description, inputSchema, execute }` object works too, for hosts with no
 * SDK — see docs/text-requests.md.)
 *
 * One text request carries `tools` (a calculator, a unit converter, and a
 * sample-data currency lookup) and the host runs the tool loop — the AI SDK
 * adapter reads `metadata.maxSteps` to bound it. The machine stays a single
 * invoking state: selecting and executing tools is the model + host's
 * business, not explicit workflow steps.
 *
 * Demonstrates:
 *   - Request-level tools: `tools: { calculate, convertUnits, lookupRate }`
 *     with real `execute` implementations — nothing canned.
 *   - `metadata.maxSteps` bounding the host-side tool loop (adapter behavior).
 *   - Progress surfaced host-side via `onTransition`.
 *
 * Want the tool loop as visible, persistable machine states instead (each
 * think/act/observe turn a transition you can snapshot and resume)? See
 * examples/react-agent.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/tool-calling/index.ts
 */
import { z } from "zod";
import { tool } from "ai";
import { openai } from "@ai-sdk/openai";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";
import { runAgent, setupAgent, type AgentRequestExecutors } from "@statelyai/agent";

export const models = defineModels({
  assistant: openai("gpt-5.4-mini"),
});

/** Sample data: a tiny fixed exchange-rate table (stand-in for a rates API). */
export const SAMPLE_RATES: Record<string, number> = {
  "USD->EUR": 0.92,
  "EUR->USD": 1.09,
  "USD->GBP": 0.79,
  "GBP->USD": 1.27,
};

const toolCallingContextSchema = z.object({
  query: z.string(),
  finalAnswer: z.string().nullable(),
});

const agentSetup = setupAgent({
  models,
  context: toolCallingContextSchema,
  input: z.object({ query: z.string() }),
  output: z.object({ finalAnswer: z.string() }),
  // answering sets `finalAnswer` before done reads it — narrowed non-null there.
  states: {
    done: { context: { finalAnswer: z.string() } },
  },
  requests: {
    answer: {
      schemas: {
        input: z.object({ query: z.string() }),
        output: z.string(),
      },
      model: "assistant",
      system:
        "Answer the user query in one friendly sentence. Use the tools: " +
        "calculate for arithmetic, convertUnits for km/mi distances, " +
        "lookupRate for currency exchange rates.",
      prompt: ({ input }) => input.query,
      // Real tools, right on the request. The host executes them in its own
      // tool loop — the machine never sees the intermediate calls.
      tools: {
        calculate: tool({
          description: "Do arithmetic on two numbers.",
          inputSchema: z.object({
            operation: z.enum(["add", "subtract", "multiply", "divide"]),
            a: z.number(),
            b: z.number(),
          }),
          execute: async (input) => {
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
            return Number.isNaN(value) ? { error: "division by zero" } : { value };
          },
        }),
        convertUnits: tool({
          description: "Convert a distance between km and mi.",
          inputSchema: z.object({
            value: z.number(),
            from: z.enum(["km", "mi"]),
            to: z.enum(["km", "mi"]),
          }),
          execute: async (input) => {
            const { value, from, to } = input;
            const converted =
              from === to ? value : from === "km" ? value / 1.609344 : value * 1.609344;
            return { value: Math.round(converted * 1000) / 1000, unit: to };
          },
        }),
        lookupRate: tool({
          description: "Look up a currency exchange rate.",
          inputSchema: z.object({ from: z.string(), to: z.string() }),
          execute: async (input) => {
            const { from, to } = input;
            const key = `${from.toUpperCase()}->${to.toUpperCase()}`;
            const rate = SAMPLE_RATES[key];
            return rate === undefined ? { error: `no sample rate for ${key}` } : { rate };
          },
        }),
      },
      // Bound the host-side tool loop (the AI SDK adapter reads this).
      metadata: { maxSteps: 5 },
    },
  },
});

export const toolCallingMachine = agentSetup.createMachine({
  id: "tool-calling",
  context: ({ input }) => ({ query: input.query, finalAnswer: null }),
  initial: "answering",
  states: {
    answering: {
      invoke: {
        src: "answer",
        input: ({ context }) => ({ query: context.query }),
        onDone: ({ output }) => ({
          target: "done",
          context: { finalAnswer: output },
        }),
      },
    },
    done: {
      type: "final",
      output: ({ context }) => ({ finalAnswer: context.finalAnswer }),
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
  finalAnswer: string;
  progress: string[];
}

/** One request answers the query, running its own tools; records progress. */
export async function runToolCallingExample(
  options: RunToolCallingOptions = {},
): Promise<ToolCallingResult> {
  const { query = "What is 42 times 17?", generateText, onProgress } = options;

  const progress: string[] = [];
  const result = await runAgent(toolCallingMachine, {
    input: { query },
    ...(generateText
      ? { executors: { generateText } }
      : { executors: createAiSdkExecutors({ models }) }),
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

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  void (async () => {
    const { generateText } = createAiSdkExecutors({ models });

    const query = "How many miles is 10 kilometers?";
    const result = await runToolCallingExample({
      query,
      generateText,
      onProgress: (state) => console.log(`  → ${state}`),
    });

    console.log("Query:", query);
    console.log("Answer:", result.finalAnswer);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
