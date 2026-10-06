/**
 * Model fallback — LangGraph's "handle tool calling errors" how-to (the
 * fallback-to-a-better-model section): a cheap model drafts the tool call,
 * and only when the tool rejects it does a stronger model get a turn.
 *
 * LangGraph shape (examples/tool-calling.ipynb, "fallback"):
 *   START → agent (cheap) → tools ─┬─ (ok) → END
 *                                  └─ (raised) → remove_failed_tool_call_attempt
 *                                     → fallback_agent (better model) → tools → …
 *
 * Machine shape — the "did the tool raise?" edge is a `choice` state:
 *   draftingQuick → validating → routing ─┬─ runningTool → answering → done
 *                                         ├─ draftingStrong → validating  (fallbacks < MAX_FALLBACKS)
 *                                         └─ failed                       (second rejection)
 *
 * What maps to what:
 *   - agent (cheap model) → `draftingQuick` (request `draftToolCall`, model "quick")
 *   - fallback_agent      → `draftingStrong` (request `draftToolCallStrong`, model
 *                           "strong", same schemas and prompt)
 *   - tool input errors   → `validating` (actor `validateToolCall`) + `routing` (choice)
 *   - remove_failed_…     → nothing to remove: the strong draft sees only the request
 *   - tools               → `runningTool` (actor `getWeather`, sample data)
 *
 * Differences from LangGraph worth calling out:
 *   - The ladder has exactly two rungs. LangGraph sends a second tool error
 *     back through the graph until `recursion_limit`; here a rejection after
 *     MAX_FALLBACKS fallbacks lands in `failed`, with every attempt listed.
 *   - Which model answered is a fact of the path: the rungs are separate named
 *     requests, and `modelUsed` is derived from `fallbacks`.
 *   - A request error on the quick rung also falls back through `routing`; an
 *     error on the strong rung is `failed`.
 *
 * Stand-ins: `getWeather` returns canned `[sample weather]` strings (no
 * network); `validateToolCall` plays the tool raising on bad input (a city
 * outside `KNOWN_CITIES`; the schema already rules out an empty list).
 * `runModelFallbackExample` takes an injectable `generateText` (tests: no API
 * key).
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/model-fallback/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAsyncLogic } from "xstate";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import {
  getStatePath,
  createAgentRuntime,
  runToQuiescence,
  setupAgent,
  type AgentRequestExecutors,
} from "@statelyai/agent";

const models = {
  quick: openai("gpt-5.4-mini"),
  strong: openai("gpt-5.4"),
};

/** Fallbacks to the strong model before a rejected call ends in `failed`. */
export const MAX_FALLBACKS = 1;

/** Sample data: canned weather per city. The tool accepts only these cities. */
export const SAMPLE_WEATHER: Record<string, string> = {
  "San Francisco": "60F, foggy",
  Boston: "48F, clear and windy",
  Tokyo: "72F, light rain",
  London: "55F, overcast",
  "New York": "58F, partly cloudy",
};

export const KNOWN_CITIES = Object.keys(SAMPLE_WEATHER);

// `min(1)` puts "at least one city" in the JSON schema the model sees, so an
// empty `get_weather()` is a malformed call (the request errors) rather than a
// call the tool has to reject.
const toolCallSchema = z.object({
  tool: z.literal("get_weather"),
  cities: z
    .array(z.string())
    .min(1)
    .describe("Every city the user asked about, at least one. Never empty."),
});

type ToolCall = z.infer<typeof toolCallSchema>;

// Both rungs share one request shape; only the model differs.
const draftRequest = {
  schemas: { input: z.object({ request: z.string() }), output: toolCallSchema },
  system:
    "Turn the user's request into one get_weather tool call. `cities` must use the " +
    `tool's exact city names, one of: ${KNOWN_CITIES.join(", ")}. Expand nicknames ` +
    "and abbreviations to those names. Name every place the user asked about; a " +
    "place not on that list goes in as written (the tool rejects it). Never swap " +
    "in a different city.",
  prompt: ({ input }: { input: { request: string } }) => input.request,
};

const modelFallbackContextSchema = z.object({
  request: z.string(),
  toolCall: toolCallSchema.nullable(),
  fallbacks: z.number(),
  /** Every drafted call and its verdict; `rejection` is null when it validated. */
  attempts: z.array(
    z.object({
      model: z.enum(["quick", "strong"]),
      call: z.string(),
      rejection: z.string().nullable(),
    }),
  ),
  toolResults: z.array(z.string()),
  answer: z.string().nullable(),
  failure: z.string().nullable(),
});

type ModelFallbackContext = z.infer<typeof modelFallbackContextSchema>;

const agentSetup = setupAgent({
  models,
  context: modelFallbackContextSchema,
  input: z.object({ request: z.string() }),
  output: z.object({
    answer: z.string(),
    modelUsed: z.enum(["quick", "strong"]),
    fallbacks: z.number(),
    toolCalls: z.string(),
  }),
  actors: {
    // The tool's input validation (the how-to's "tool raises" moment), as data.
    validateToolCall: createAsyncLogic<{ rejection: string | null }, ToolCall>({
      run: async ({ input }) => {
        const bad = input.cities.length
          ? input.cities.filter((c) => !KNOWN_CITIES.includes(c))
          : ["(none)"];
        return { rejection: bad.length ? `get_weather rejects cities: ${bad.join(", ")}` : null };
      },
    }),
    // tools: canned sample weather, clearly labeled. No network.
    getWeather: createAsyncLogic<string[], { cities: string[] }>({
      run: async ({ input }) =>
        input.cities.map((city) => `[sample weather] ${city}: ${SAMPLE_WEATHER[city]}`),
    }),
  },
  requests: {
    draftToolCall: { ...draftRequest, model: "quick" },
    draftToolCallStrong: { ...draftRequest, model: "strong" },
    // One line per city, joined in code (see `answering`): a model's own line
    // breaks are single newlines, which Markdown collapses into one run-on line.
    answerFromWeather: {
      schemas: {
        input: z.object({ request: z.string(), results: z.array(z.string()) }),
        output: z.object({
          lines: z.array(z.string()).min(1).describe("One short line per city."),
        }),
      },
      model: "quick",
      system: "Answer the user's request from the tool results only. Be brief.",
      prompt: ({ input }) =>
        [`Request: ${input.request}`, "Tool results:", ...input.results].join("\n"),
    },
  },
});

/** Appends the current rung's drafted call and its verdict to the attempt log. */
function logAttempt(context: ModelFallbackContext, rejection: string | null) {
  const model = context.fallbacks > 0 ? ("strong" as const) : ("quick" as const);
  const call = context.toolCall
    ? `get_weather(${context.toolCall.cities.join(", ")})`
    : "(no call)";
  return { attempts: [...context.attempts, { model, call, rejection }] };
}

function finalOutput(context: ModelFallbackContext, answer: string) {
  return {
    answer,
    modelUsed: context.fallbacks > 0 ? ("strong" as const) : ("quick" as const),
    fallbacks: context.fallbacks,
    toolCalls: context.attempts
      .map((a) => `${a.model}: ${a.call} ${a.rejection ? `rejected (${a.rejection})` : "accepted"}`)
      .join("\n\n"),
  };
}

/** Every `onError` past the quick rung: record which step failed, end in `failed`. */
const failWith =
  (step: string) =>
  ({ event }: { event: { error: unknown } }) => ({
    target: "failed" as const,
    context: { failure: `${step} failed: ${String(event.error)}` },
  });

export const modelFallbackSchemas = agentSetup.schemas;

export const modelFallbackMachine = agentSetup.createMachine({
  id: "model-fallback",
  context: ({ input }) => ({
    request: input.request,
    toolCall: null,
    fallbacks: 0,
    attempts: [],
    toolResults: [],
    answer: null,
    failure: null,
  }),
  initial: "draftingQuick",
  states: {
    draftingQuick: {
      invoke: {
        src: "draftToolCall",
        input: ({ context }) => ({ request: context.request }),
        onDone: ({ output }) => ({ target: "validating", context: { toolCall: output.result } }),
        // A failed call on the cheap rung is what the fallback is for: route it
        // through the same budget check as a rejected tool call.
        onError: ({ context, event }) => ({
          target: "routing",
          context: logAttempt(context, `draftToolCall failed: ${String(event.error)}`),
        }),
      },
    },
    // Same request on the strong model; the rejected call is dropped, as in the how-to.
    draftingStrong: {
      invoke: {
        src: "draftToolCallStrong",
        input: ({ context }) => ({ request: context.request }),
        onDone: ({ output }) => ({ target: "validating", context: { toolCall: output.result } }),
        onError: failWith("draftToolCallStrong"),
      },
    },
    validating: {
      invoke: {
        src: "validateToolCall",
        input: ({ context }) => context.toolCall ?? { tool: "get_weather" as const, cities: [] },
        onDone: ({ context, output }) => ({
          target: "routing",
          context: logAttempt(context, output.rejection),
        }),
        onError: failWith("validateToolCall"),
      },
    },
    // Valid → run the tool; rejected with a rung left → strong model; else give up.
    routing: {
      type: "choice",
      choice: ({ context }) => {
        const rejection = context.attempts.at(-1)?.rejection ?? null;
        if (rejection === null) return { target: "runningTool" };
        if (context.fallbacks < MAX_FALLBACKS) {
          return { target: "draftingStrong", context: { fallbacks: context.fallbacks + 1 } };
        }
        return { target: "failed", context: { failure: `Both models' calls were rejected.` } };
      },
    },
    runningTool: {
      invoke: {
        src: "getWeather",
        input: ({ context }) => ({ cities: context.toolCall?.cities ?? [] }),
        onDone: ({ output }) => ({ target: "answering", context: { toolResults: output } }),
        onError: failWith("get_weather"),
      },
    },
    answering: {
      invoke: {
        src: "answerFromWeather",
        input: ({ context }) => ({ request: context.request, results: context.toolResults }),
        // A blank line between lines keeps them apart when rendered as Markdown.
        onDone: ({ output }) => ({
          target: "done",
          context: { answer: output.result.lines.join("\n\n") },
        }),
        onError: failWith("answerFromWeather"),
      },
    },
    done: {
      type: "final",
      output: ({ context }) => finalOutput(context, context.answer ?? ""),
    },
    // Both rungs rejected (or a call failed): say why, with every attempt.
    failed: {
      type: "final",
      output: ({ context }) =>
        finalOutput(context, `Could not answer: ${context.failure ?? "unknown failure"}`),
    },
  },
});

/** Runs the ladder; records state progress so the fallback is observable. */
export async function runModelFallbackExample(
  options: {
    request?: string;
    /** Injected for tests; the direct run supplies a real model executor. */
    generateText?: AgentRequestExecutors["generateText"];
    onProgress?: (state: string) => void;
  } = {},
) {
  const { request = "Get the weather for San Francisco, Boston and Tokyo", generateText } = options;
  const progress: string[] = [];
  const result = await runToQuiescence(
    createAgentRuntime(modelFallbackMachine, {
      executors: generateText ? { generateText } : createAiSdkExecutors({ models }),
      onTransition: (snapshot) => {
        const state = getStatePath(snapshot);
        progress.push(state);
        options.onProgress?.(state);
      },
    }),
    {
      input: { request },
    },
  );
  if (result.status !== "done") {
    throw new Error(`Model-fallback example did not complete: ${result.status}`);
  }
  return { ...result.output, outcome: getStatePath(result.snapshot), progress };
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  void (async () => {
    const result = await runModelFallbackExample({
      onProgress: (state) => console.log(`  → ${state}`),
    });
    console.log(`\n[${result.outcome}, model: ${result.modelUsed}] ${result.toolCalls}`);
    console.log(result.answer);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
