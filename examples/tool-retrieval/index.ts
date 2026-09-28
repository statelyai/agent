/**
 * Tool retrieval — pick a handful of tools from a large registry first, then
 * let the model work with only those, ported from langgraph-bigtool and
 * LangGraph's "How to handle large numbers of tools" guide.
 *
 * The idea: binding hundreds of tools to one model call is slow, expensive
 * and confuses the model. Instead, search the registry for the few tools that
 * look relevant to the question, expose only those, and let the agent ask for
 * a new search when none of them fit.
 *
 * LangGraph shape (langgraph-bigtool / how-tos/many-tools):
 *
 *   START → select_tools (vector search over tool descriptions)
 *         → agent (ReAct, bound to the selected tools) ─┬─ tools → agent
 *                                                       ├─ retrieve_tools → agent
 *                                                       └─ (no tool call) → END
 *
 * Machine shape:
 *
 *   selectingTools → deciding ─┬─ CALL_TOOL (tool selected, calls < MAX_TOOL_CALLS) → runningTool → deciding
 *        ▲                     ├─ RESELECT (reselections < MAX_RESELECTIONS) ─┐
 *        └─────────────────────┼──────────────────────────────────────────────┘
 *                              ├─ ANSWER → done
 *                              └─ (decide retries exhausted) → failed
 *
 * What maps to what:
 *   - select_tools / retrieve_tools → `selectingTools`: ONE Jev call that
 *     reranks the whole registry (one boolean question per tool, see note); the machine
 *     keeps the top TOOLS_PER_SELECTION above TOOL_RELEVANCE_THRESHOLD
 *   - agent → `deciding`: `agent.decide` (name `chooseTool`) over CALL_TOOL,
 *     RESELECT and ANSWER
 *   - binding only the selected tools → the CALL_TOOL guard: a tool outside
 *     the selected set is rejected and the decision retries
 *   - tools (ToolNode) → `runningTool`: a plain actor that runs the registry
 *     function and appends `{ tool, arg, result }` to `calls`
 *
 * Differences from LangGraph worth calling out:
 *   - Selection is a JUDGMENT, not a search or a generation. bigtool embeds
 *     the query and takes the nearest tool descriptions. Here `selectingTools`
 *     calls the AI SDK's `experimental_evaluate` with Jev
 *     (`@ai-sdk/typesafe-ai`) as the evaluation model, with the query and
 *     every registry tool's name and description as state, and one boolean
 *     question per tool
 *     ("could this tool help answer the question?"). The probabilities are the
 *     rerank scores; the threshold and the top-k cut are code, in `onDone`.
 *     The text model only makes the `chooseTool` decision.
 *   - "Only the selected tools exist" is a guard, not a binding. The model can
 *     name any registry tool, and the machine refuses the ones not selected, so
 *     the rule holds whatever the host's tool-binding does.
 *   - Tool calls and reselections are budgets checked in guards
 *     (MAX_TOOL_CALLS, MAX_RESELECTIONS). LangGraph bounds the ReAct loop with
 *     recursion_limit, which raises. Here an over-budget choice is rejected and
 *     the model must ANSWER; if it will not, the decision fails into `failed`.
 *   - Like bigtool, reselection ADDS to the selected set rather than replacing it.
 *   - The agent answers with an ANSWER event instead of a final assistant
 *     message; one tool call per turn, no parallel tool calls.
 *
 * Stand-ins: TOOL_REGISTRY is twelve small pure functions (unit conversions,
 * string utilities, arithmetic, ISO date math, a capital-city lookup over a
 * tiny table).
 *
 * Run: OPENAI_API_KEY=... TYPESAFE_AI_API_KEY=... npx tsx examples/tool-retrieval/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAsyncLogic } from "xstate";
import { experimental_evaluate as evaluate, type Experimental_EvaluationModel } from "ai";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import { getStatePath, runAgent, setupAgent, type AgentRequestExecutors } from "@statelyai/agent";

const models = { agent: openai("gpt-6-luna") };

/**
 * The judge: TypeSafe's Jev through the AI SDK's evaluation-model provider.
 * Reads `TYPESAFE_AI_API_KEY`. Tests pass a mock evaluation model instead.
 */
const judgeModel: Experimental_EvaluationModel = typeSafeAi.evaluationModel("jev-latest");

/** How many tools one selection exposes. */
export const TOOLS_PER_SELECTION = 3;
/** A tool is selectable when Jev's probability that it helps clears this. */
export const TOOL_RELEVANCE_THRESHOLD = 0.5;
/** How many times the model may ask for a new selection. */
export const MAX_RESELECTIONS = 2;
/** How many tool calls one run may make. */
export const MAX_TOOL_CALLS = 4;

export interface RegistryTool {
  name: string;
  description: string;
  run: (arg: string) => string;
}

function numberArg(arg: string, run: (value: number) => string): string {
  const value = Number.parseFloat(arg);
  return Number.isFinite(value) ? run(value) : `error: expected a number, got "${arg}"`;
}

const round = (value: number) => String(Math.round(value * 100) / 100);
const isoDay = (text: string) => Date.parse(`${text}T00:00:00Z`) / 86_400_000;

/** Sample data for the lookup tool. */
const CAPITALS: Record<string, string> = {
  australia: "Canberra",
  canada: "Ottawa",
  brazil: "Brasília",
  japan: "Tokyo",
  kenya: "Nairobi",
};

/** The tool registry: small, pure, hand-written functions. */
export const TOOL_REGISTRY: RegistryTool[] = [
  {
    name: "celsius_to_fahrenheit",
    description: "Convert a temperature in degrees Celsius to Fahrenheit.",
    run: (arg) => numberArg(arg, (c) => `${round(c * 1.8 + 32)} °F`),
  },
  {
    name: "fahrenheit_to_celsius",
    description: "Convert a temperature in degrees Fahrenheit to Celsius.",
    run: (arg) => numberArg(arg, (f) => `${round((f - 32) / 1.8)} °C`),
  },
  {
    name: "km_to_miles",
    description: "Convert a distance or length in kilometers to miles.",
    run: (arg) => numberArg(arg, (km) => `${round(km * 0.621371)} miles`),
  },
  {
    name: "kg_to_pounds",
    description: "Convert a weight or mass in kilograms to pounds.",
    run: (arg) => numberArg(arg, (kg) => `${round(kg * 2.20462)} lb`),
  },
  {
    name: "word_count",
    description: "Count how many words are in a piece of text.",
    run: (arg) => String(arg.split(/\s+/).filter(Boolean).length),
  },
  {
    name: "reverse_text",
    description: "Reverse the characters of a text string.",
    run: (arg) => [...arg].reverse().join(""),
  },
  {
    name: "slugify",
    description: "Turn a title into a lowercase URL slug with hyphens.",
    run: (arg) =>
      arg
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, ""),
  },
  {
    name: "sum_numbers",
    description: "Add up a comma-separated list of numbers and return the sum total.",
    run: (arg) => {
      const values = arg.split(",").map((part) => Number.parseFloat(part));
      return values.every(Number.isFinite)
        ? round(values.reduce((sum, value) => sum + value, 0))
        : `error: expected numbers like "3, 4.5", got "${arg}"`;
    },
  },
  {
    name: "percent_of",
    description: "Compute a percentage of a number, as 'percent of number', e.g. '15 of 80'.",
    run: (arg) => {
      const match = arg.match(/^\s*([\d.]+)\s*%?\s*of\s*([\d.]+)\s*$/);
      return match
        ? round((Number(match[1]) / 100) * Number(match[2]))
        : `error: expected "15 of 80", got "${arg}"`;
    },
  },
  {
    name: "days_between",
    description: "Count the days between two ISO dates, as 'YYYY-MM-DD YYYY-MM-DD'.",
    run: (arg) => {
      const [from, to] = arg.trim().split(/\s+/);
      const days = isoDay(to ?? "") - isoDay(from ?? "");
      return Number.isFinite(days)
        ? `${days} days`
        : `error: expected "2026-01-15 2026-03-01", got "${arg}"`;
    },
  },
  {
    name: "add_days",
    description: "Add a number of days to an ISO date, as 'YYYY-MM-DD N', and return the new date.",
    run: (arg) => {
      const [date, count] = arg.trim().split(/\s+/);
      const day = isoDay(date ?? "") + Number(count);
      return Number.isFinite(day)
        ? new Date(day * 86_400_000).toISOString().slice(0, 10)
        : `error: expected "2026-01-15 30", got "${arg}"`;
    },
  },
  {
    name: "lookup_capital",
    description: "Look up the capital city of a country in a small sample table.",
    run: (arg) =>
      CAPITALS[arg.trim().toLowerCase()] ?? `[sample table] no capital on file for "${arg}"`,
  },
];

const TOOL_NAMES = TOOL_REGISTRY.map((tool) => tool.name) as [string, ...string[]];

/**
 * select_tools as a judgment rerank: the query and every registry tool's
 * name and description are the state, and each tool gets its own boolean
 * question, keyed by the tool's name. One call, one probability per tool. The
 * judge model is injected by tests and hosts; the default is Jev.
 */
export function createSelectTools(model: Experimental_EvaluationModel = judgeModel) {
  return createAsyncLogic<{ answers: Record<string, { probability: number }> }, { query: string }>({
    run: async ({ input, signal }) => {
      const { answers } = await evaluate({
        model,
        state: {
          question: input.query,
          tools: TOOL_REGISTRY.map(({ name, description }) => ({ name, description })),
        },
        questions: Object.fromEntries(
          TOOL_REGISTRY.map((tool, index) => [
            tool.name,
            {
              type: "boolean" as const,
              instructions: `Could the tool \`tools[${index}]\` be used to answer \`question\`?`,
              criteria: {
                true: "Calling this tool with some argument produces a result the answer needs.",
                false: "The tool does something else, or only shares vocabulary with the question.",
              },
            },
          ]),
        ),
        abortSignal: signal,
      });
      return { answers };
    },
  });
}

/** Tool names whose probability clears the threshold, best first, top TOOLS_PER_SELECTION. */
function rankTools(answers: Record<string, { probability: number } | undefined>): string[] {
  return TOOL_REGISTRY.map((tool) => ({ name: tool.name, p: answers[tool.name]?.probability ?? 0 }))
    .filter((scored) => scored.p >= TOOL_RELEVANCE_THRESHOLD)
    .sort((left, right) => right.p - left.p)
    .slice(0, TOOLS_PER_SELECTION)
    .map((scored) => scored.name);
}

const callSchema = z.object({ tool: z.string(), arg: z.string(), result: z.string() });
type ToolCall = z.infer<typeof callSchema>;

const retrievalContextSchema = z.object({
  question: z.string(),
  // What the last selection searched for: the question, then each RESELECT query.
  query: z.string(),
  selectedTools: z.array(z.string()),
  reselections: z.number(),
  calls: z.array(callSchema),
  pendingCall: z.object({ tool: z.string(), arg: z.string() }).nullable(),
  answer: z.string().nullable(),
});
type RetrievalContext = z.infer<typeof retrievalContextSchema>;

function renderCalls(calls: ToolCall[]): string {
  if (calls.length === 0) return "(no tool calls)";
  return calls
    .map((call) => `${call.tool}(${JSON.stringify(call.arg)}) → ${call.result}`)
    .join("\n");
}

function decisionPrompt(context: RetrievalContext): string {
  const selected = TOOL_REGISTRY.filter((tool) => context.selectedTools.includes(tool.name));
  return [
    // First line lists the tools, so a reader sees them first.
    `Available tools: ${context.selectedTools.join(", ") || "(none matched)"}`,
    ...selected.map((tool) => `- ${tool.name}: ${tool.description}`),
    `Question: ${context.question}`,
    "Tool calls so far:",
    renderCalls(context.calls),
    `Tool calls left: ${MAX_TOOL_CALLS - context.calls.length}. Reselections left: ${MAX_RESELECTIONS - context.reselections}.`,
  ].join("\n");
}

const agentSetup = setupAgent({
  models,
  context: retrievalContextSchema,
  input: z.object({ question: z.string() }),
  output: z.object({
    answer: z.string(),
    calls: z.string(),
    selectedTools: z.array(z.string()),
    reselections: z.number(),
  }),
  events: {
    /** Run one selected tool. `tool` must be in the selected set. */
    CALL_TOOL: z.object({ tool: z.enum(TOOL_NAMES), arg: z.string() }),
    /** Search the registry again for tools matching `query`. */
    RESELECT: z.object({ query: z.string() }),
    /** Finish with the answer to the question. */
    ANSWER: z.object({ answer: z.string() }),
  },
  actors: {
    // select_tools: a Jev rerank of the registry (see createSelectTools).
    selectTools: createSelectTools(),
    // tools (ToolNode): run one registry function.
    runTool: createAsyncLogic<string, { tool: string; arg: string }>({
      run: async ({ input }) => {
        const tool = TOOL_REGISTRY.find((entry) => entry.name === input.tool);
        if (!tool) throw new Error(`Unknown tool: ${input.tool}`);
        return tool.run(input.arg);
      },
    }),
  },
});

export const toolRetrievalSchemas = agentSetup.schemas;

export const toolRetrievalMachine = agentSetup.createMachine({
  id: "tool-retrieval",
  context: ({ input }) => ({
    question: input.question,
    query: input.question,
    selectedTools: [],
    reselections: 0,
    calls: [],
    pendingCall: null,
    answer: null,
  }),
  initial: "selectingTools",
  states: {
    selectingTools: {
      invoke: {
        src: "selectTools",
        input: ({ context }) => ({ query: context.query }),
        // Keep the top TOOLS_PER_SELECTION above the threshold. Like bigtool,
        // a new selection adds to the tools already selected.
        onDone: ({ context, output }) => ({
          target: "deciding",
          context: {
            selectedTools: [...new Set([...context.selectedTools, ...rankTools(output.answers)])],
          },
        }),
        onError: { target: "failed" },
      },
    },
    deciding: {
      invoke: {
        src: "agent.decide",
        input: ({ context }) => ({
          model: "agent",
          name: "chooseTool",
          system:
            "Answer the question. You may call ONE of the available tools per turn (CALL_TOOL with " +
            "its argument string), ask for a new tool search (RESELECT with a short query) if none " +
            "fit, or give the final answer (ANSWER). Only the listed tools exist.",
          prompt: decisionPrompt(context),
          allowedEvents: ["CALL_TOOL", "RESELECT", "ANSWER"],
        }),
        // Retries exhausted: the model kept choosing moves the machine refused.
        onError: { target: "failed" },
      },
      on: {
        // The binding: only a selected tool, and only within the call budget.
        CALL_TOOL: ({ context, event }) =>
          context.selectedTools.includes(event.tool) && context.calls.length < MAX_TOOL_CALLS
            ? {
                target: "runningTool",
                context: { pendingCall: { tool: event.tool, arg: event.arg } },
              }
            : undefined,
        RESELECT: ({ context, event }) =>
          context.reselections < MAX_RESELECTIONS
            ? {
                target: "selectingTools",
                context: { query: event.query, reselections: context.reselections + 1 },
              }
            : undefined,
        ANSWER: ({ event }) => ({ target: "done", context: { answer: event.answer } }),
      },
    },
    runningTool: {
      invoke: {
        src: "runTool",
        input: ({ context }) => context.pendingCall ?? { tool: "", arg: "" },
        onDone: ({ context, output }) => ({
          target: "deciding",
          context: {
            calls: [
              ...context.calls,
              {
                tool: context.pendingCall?.tool ?? "",
                arg: context.pendingCall?.arg ?? "",
                result: output,
              },
            ],
            pendingCall: null,
          },
        }),
        onError: { target: "failed" },
      },
    },
    done: {
      type: "final",
      output: ({ context }) => ({
        answer: context.answer ?? "",
        calls: renderCalls(context.calls),
        selectedTools: context.selectedTools,
        reselections: context.reselections,
      }),
    },
    failed: {
      type: "final",
      output: ({ context }) => ({
        answer: `No answer: the agent stopped after ${context.calls.length} tool call(s) and ${context.reselections} reselection(s) without a legal final move.`,
        calls: renderCalls(context.calls),
        selectedTools: context.selectedTools,
        reselections: context.reselections,
      }),
    },
  },
});

export interface RunToolRetrievalOptions {
  question?: string;
  /** Injected for tests; the direct run supplies a real model executor. */
  decide?: AgentRequestExecutors["decide"];
  /** The judge model; tests pass a mock, the direct run uses Jev. */
  judge?: Experimental_EvaluationModel;
  onProgress?: (state: string) => void;
}

export interface ToolRetrievalResult {
  answer: string;
  calls: string;
  selectedTools: string[];
  reselections: number;
  /** `done`, or `failed` when the model never made a legal final move. */
  finalState: string;
  progress: string[];
}

/** Runs select → decide ⇄ tools; records state progress so each branch is observable. */
export async function runToolRetrievalExample(
  options: RunToolRetrievalOptions = {},
): Promise<ToolRetrievalResult> {
  const {
    question = "How many miles is a 42.195 km marathon?",
    decide,
    judge,
    onProgress,
  } = options;
  const progress: string[] = [];
  const result = await runAgent(toolRetrievalMachine, {
    input: { question },
    ...(decide ? { executors: { decide } } : { executors: createAiSdkExecutors({ models }) }),
    ...(judge ? { actors: { selectTools: createSelectTools(judge) } } : {}),
    onTransition: (snapshot) => {
      const state = getStatePath(snapshot);
      progress.push(state);
      onProgress?.(state);
    },
  });

  if (result.status !== "done") {
    throw new Error(`Tool retrieval example did not complete: ${result.status}`);
  }
  return { ...result.output, finalState: getStatePath(result.snapshot), progress };
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY || !process.env.TYPESAFE_AI_API_KEY) {
    console.error("Set OPENAI_API_KEY and TYPESAFE_AI_API_KEY to run this example.");
    process.exit(1);
  }
  void (async () => {
    const { decide } = createAiSdkExecutors({ models });
    const result = await runToolRetrievalExample({
      decide,
      onProgress: (state) => console.log(`  → ${state}`),
    });
    console.log(`\nSelected: ${result.selectedTools.join(", ")}`);
    console.log(`Calls:\n${result.calls}`);
    console.log(`\nAnswer (${result.finalState}): ${result.answer}`);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
