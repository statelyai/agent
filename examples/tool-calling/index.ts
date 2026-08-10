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
 * adapter reads `metadata.maxSteps` to bound it. Selecting and executing tools
 * is the model + host's business, not explicit workflow steps.
 *
 * What the MACHINE owns is the contract on the way out. The request returns a
 * structured `{ answer, value, unit }`, and a `validating` choice state accepts
 * it only if a tool actually produced the number (`value` non-null) and the
 * unit is one the tools deal in. A rejection is not an exception: the note goes
 * into context, the model retries with it in the prompt, and a spent budget
 * ends in a `denied` outcome that says so.
 *
 *   answering → validating ─┬─ done                       (contract met)
 *                           ├─ retrying → answering → …   (note in the prompt)
 *                           └─ denied                     (budget spent)
 *
 * Demonstrates:
 *   - Request-level tools: `tools: { calculate, convertUnits, lookupRate }`
 *     with real `execute` implementations — nothing canned. Bad arguments are
 *     denied by the tools themselves (divide by zero, unknown currency pair).
 *   - A typed output contract the machine enforces, with a bounded retry that
 *     feeds the validation message back to the model.
 *   - `metadata.maxSteps` bounding the host-side tool loop (adapter behavior).
 *   - Progress and the validation trail surfaced host-side via `onTransition`.
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

/** The only units the tools deal in. The machine enforces this, not the prompt. */
export const SUPPORTED_UNITS = ["km", "mi", "USD", "EUR", "GBP", "none"] as const;

/** The request's typed output contract: prose, plus the number behind it. */
const answerSchema = z.object({
  answer: z.string(),
  /** The number a tool returned; `null` when no tool could produce one. */
  value: z.number().nullable(),
  /** The unit that number is in, or `null`. */
  unit: z.string().nullable(),
});

const toolCallingContextSchema = z.object({
  query: z.string(),
  answer: z.string(),
  value: z.number().nullable(),
  unit: z.string().nullable(),
  /** Empty when the last answer met the contract; otherwise why it did not. */
  validationNote: z.string(),
  attempts: z.number(),
  maxAttempts: z.number(),
});

const agentSetup = setupAgent({
  models,
  context: toolCallingContextSchema,
  input: z.object({ query: z.string(), maxAttempts: z.number().default(2) }),
  output: z.object({
    answer: z.string(),
    value: z.number().nullable(),
    unit: z.string().nullable(),
    validated: z.boolean(),
    attempts: z.number(),
  }),
  requests: {
    answer: {
      schemas: {
        input: z.object({ query: z.string(), validationNote: z.string() }),
        output: answerSchema,
      },
      model: "assistant",
      system:
        "Answer the user query in one friendly sentence. Use the tools: " +
        "calculate for arithmetic, convertUnits for km/mi distances, " +
        "lookupRate for currency exchange rates. Return the number a tool gave " +
        "you as `value` and its unit as `unit` (`none` for a plain number). If " +
        "no tool can produce the number, set `value` to null and say so.",
      prompt: ({ input }) =>
        input.validationNote
          ? `${input.query}\n\nYour last answer was rejected: ${input.validationNote}`
          : input.query,
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

/**
 * The output contract, checked host-side. Returns the rejection message, or
 * `""` when the answer is acceptable.
 */
export function validateAnswer(answer: z.infer<typeof answerSchema>): string {
  if (answer.value === null) {
    return "No tool produced a number. Call calculate, convertUnits, or lookupRate and report its result as `value`.";
  }
  if (answer.unit !== null && !SUPPORTED_UNITS.includes(answer.unit as never)) {
    return `\`${answer.unit}\` is not a unit these tools deal in. Use one of: ${SUPPORTED_UNITS.join(", ")}.`;
  }
  return "";
}

export const toolCallingMachine = agentSetup.createMachine({
  id: "tool-calling",
  context: ({ input }) => ({
    query: input.query,
    answer: "",
    value: null,
    unit: null,
    validationNote: "",
    attempts: 0,
    maxAttempts: input.maxAttempts,
  }),
  initial: "answering",
  states: {
    answering: {
      invoke: {
        src: "answer",
        input: ({ context }) => ({
          query: context.query,
          validationNote: context.validationNote,
        }),
        onDone: ({ context, output }) => ({
          target: "validating",
          context: {
            answer: output.answer,
            value: output.value,
            unit: output.unit,
            validationNote: validateAnswer(output),
            attempts: context.attempts + 1,
          },
        }),
      },
    },
    // The denial branch, as a state you can point at: accept, retry with the
    // note, or give up honestly.
    validating: {
      type: "choice",
      choice: ({ context }) =>
        context.validationNote === ""
          ? { target: "done" }
          : context.attempts >= context.maxAttempts
            ? { target: "denied" }
            : { target: "retrying" },
    },
    // A visible marker: the note is already in context, and `answering`'s input
    // feeds it into the next prompt.
    retrying: {
      always: { target: "answering" },
    },
    done: {
      type: "final",
      output: ({ context }) => ({
        answer: context.answer,
        value: context.value,
        unit: context.unit,
        validated: true,
        attempts: context.attempts,
      }),
    },
    // Best-effort terminal: the contract was never met within the budget.
    denied: {
      type: "final",
      output: ({ context }) => ({
        answer: `Could not answer within ${context.attempts} attempts. ${context.validationNote}`,
        value: null,
        unit: null,
        validated: false,
        attempts: context.attempts,
      }),
    },
  },
});

export interface RunToolCallingOptions {
  query?: string;
  /** How many answering attempts the validation branch may spend. */
  maxAttempts?: number;
  /** Injected for tests; direct run supplies a real model executor. */
  generateText?: AgentRequestExecutors["generateText"];
  /** Observes each machine transition (progress). */
  onProgress?: (state: string) => void;
}

export interface ToolCallingResult {
  answer: string;
  value: number | null;
  unit: string | null;
  validated: boolean;
  attempts: number;
  progress: string[];
  /** Every rejection message the machine raised, in order. */
  rejections: string[];
}

/** One request answers the query, running its own tools; records progress. */
export async function runToolCallingExample(
  options: RunToolCallingOptions = {},
): Promise<ToolCallingResult> {
  const { query = "What is 42 times 17?", maxAttempts = 2, generateText, onProgress } = options;

  const progress: string[] = [];
  const rejections: string[] = [];
  const result = await runAgent(toolCallingMachine, {
    input: { query, maxAttempts },
    ...(generateText
      ? { executors: { generateText } }
      : { executors: createAiSdkExecutors({ models }) }),
    onTransition: (snapshot) => {
      const state = String(snapshot.value);
      progress.push(state);
      onProgress?.(state);
      const { validationNote } = snapshot.context;
      if (validationNote && rejections.at(-1) !== validationNote) rejections.push(validationNote);
    },
  });

  if (result.status !== "done") {
    throw new Error(`Tool-calling example did not complete: ${result.status}`);
  }
  return { ...result.output, progress, rejections };
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
    for (const rejection of result.rejections) console.log("  rejected:", rejection);
    console.log("Answer:", result.answer);
    console.log("Validated:", result.validated, `(${result.attempts} attempt(s))`);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
