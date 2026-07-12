/**
 * Vercel AI SDK host for XState agent machines — the `runAgent`-based wiring.
 *
 * Wiring demonstrated: hand the machine and an executor set to `runAgent`,
 * which drives the whole run to completion for you (`runTriageDemo`,
 * `runStreamingDemo`). The machine declares named text logic calls; this host
 * provides their execution with the AI SDK. Streaming chunks flow through the
 * host side channel (`onChunk` → stdout, HTTP stream, etc.) — the machine
 * itself only transitions on the final text. `runTriageStepDemo` also shows
 * the manual step loop against the same triage machine for comparison.
 *
 * Executors come from the shared `createAiSdkExecutors` adapter (the same one
 * every other example uses) — this host does not hand-roll AI SDK calls. The
 * demo entrypoints accept an injected `generateText`/`streamText` so tests can
 * drive them with mock executors; production wiring supplies the AI SDK set.
 *
 * Compare `../ai-sdk-game-host/index.ts` for the explicit step-path wiring
 * (`initialAgentStep`/`resolveAgentStep`/`transitionAgentStep`), which is what
 * you reach for when the host — not `runAgent` — owns the loop (e.g. decisions,
 * persistence between steps, a serverless request per turn).
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/ai-sdk-host/index.ts
 */
import { type LanguageModel } from "ai";
import { openai } from "@ai-sdk/openai";
import {
  executeAgentRequest,
  initialAgentStep,
  resolveAgentStep,
  runAgent,
  type AgentRequestExecutor,
  type AgentRequestExecutors,
  type StandardSchemaV1,
  type TextLogic,
  type TextLogicOutput,
} from "../../src/index.js";
import { createAiSdkExecutors } from "../../src/ai-sdk/index.js";
import { jokeMachine, models as jokeModels, tellJoke } from "../joke/index.js";
import {
  models as triageModels,
  triageActors,
  triageMachine,
  triageSchemas,
} from "../triage/index.js";
import { runExampleMain } from "../helpers/main.js";

// ─── Host Adapter: AI SDK execution ───

interface AiSdkTextHostOptions {
  models?: Record<string, LanguageModel>;
  resolveModel?: (modelRef: string) => LanguageModel;
  onChunk?: (chunk: string) => void;
}

function defaultResolveModel(modelRef: string): LanguageModel {
  return openai(modelRef.replace(/^openai\//, ""));
}

/**
 * Builds the canonical AI SDK executor set for the given options. A static
 * `models` map is used directly; otherwise refs resolve through
 * `resolveModel` (defaulting to the `openai(...)` provider). This is the one
 * seam between the host and `createAiSdkExecutors` — everything else is
 * expressed as thin wrappers over the returned executors.
 */
function executorsFor(options: AiSdkTextHostOptions = {}): AgentRequestExecutors {
  return options.models
    ? createAiSdkExecutors({ models: options.models })
    : createAiSdkExecutors({
        resolveModel: options.resolveModel ?? defaultResolveModel,
      });
}

/**
 * Wraps a text logic in an executor backed by `createAiSdkExecutors.generateText`.
 * Used by `../cloudflare-agent-host` to provide `emailDrafter`'s actors.
 */
export function createAiSdkTextActor<
  TInputSchema extends StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1,
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
>(
  logic: TextLogic<TInputSchema, TOutputSchema, TMetadata>,
  options: AiSdkTextHostOptions = {},
): TextLogic<TInputSchema, TOutputSchema, TMetadata> {
  const { generateText } = executorsFor(options);
  return logic.withExecutor(async ({ request, signal }) => {
    const { output } = await generateText({ ...request, tools: request.tools ?? {} }, { signal });
    return { output: output as TextLogicOutput<typeof logic> };
  });
}

/**
 * Wraps a `mode: 'stream'` text logic in an executor backed by
 * `createAiSdkExecutors.streamText`, forwarding chunks to `options.onChunk`.
 */
export function createAiSdkStreamingTextActor<
  TInputSchema extends StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1,
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
>(
  logic: TextLogic<TInputSchema, TOutputSchema, TMetadata>,
  options: AiSdkTextHostOptions = {},
): TextLogic<TInputSchema, TOutputSchema, TMetadata> {
  const { streamText } = executorsFor(options);
  return logic.withExecutor(async ({ request, signal }) => {
    const { output } = await streamText!(
      { ...request, tools: request.tools ?? {} },
      { onChunk: options.onChunk, signal },
    );
    return { output: output as TextLogicOutput<typeof logic> };
  });
}

// ─── Demos ───

export async function runTriageDemo(
  ticket: string,
  generateText: AgentRequestExecutor = executorsFor({ models: triageModels }).generateText,
) {
  const result = await runAgent(triageMachine, {
    input: { ticket },
    generateText,
    // The host-side observability hook: log each machine transition as it runs.
    onTransition: (snapshot) => console.log(`  state -> ${String(snapshot.value)}`),
  });
  if (result.status !== "done") {
    throw new Error(`Triage demo did not complete: ${result.status}`);
  }
  return result.output;
}

export async function runTriageStepDemo(
  ticket: string,
  generateText: AgentRequestExecutor = executorsFor({ models: triageModels }).generateText,
) {
  let step = initialAgentStep(
    triageMachine,
    { ticket },
    {
      schemas: triageSchemas,
      actorSources: triageActors,
    },
  );

  while (!step.done) {
    if (step.requests.length === 0) {
      throw new Error("Machine is waiting without an agent request.");
    }

    for (const request of step.requests) {
      if (request.kind !== "text") {
        throw new Error("Decision requests are not supported in this demo.");
      }
      const output = await executeAgentRequest(request, { generateText });
      step = resolveAgentStep(triageMachine, step, request, output, {
        schemas: triageSchemas,
        actorSources: triageActors,
      });
    }
  }

  return step.snapshot.output;
}

export async function runStreamingDemo(
  topic: string,
  streamingTellJoke: TextLogic<
    typeof tellJoke.schemas.input,
    typeof tellJoke.schemas.output
  > = createAiSdkStreamingTextActor(tellJoke, {
    models: jokeModels,
    // The side channel: chunks go to stdout as they arrive. In a server
    // this is a UIMessageStream writer or Response stream instead.
    onChunk: (chunk) => process.stdout.write(chunk),
  }),
) {
  const result = await runAgent(
    jokeMachine.provide({ actorSources: { tellJoke: streamingTellJoke } }),
    {
      input: { topic },
      // Rate the streamed joke; the decision then ends the loop after one joke.
      // The chosen END event is delivered to the machine automatically.
      generateText: async () => ({ output: { rating: 9, explanation: "solid pun" } }),
      decide: async () => ({ event: { type: "END" as const } }),
      onTransition: (snapshot) => console.log("\n  state ->", JSON.stringify(snapshot.value)),
    },
  );
  process.stdout.write("\n");
  if (result.status !== "done") {
    throw new Error(`runStreamingDemo did not complete: ${result.status}`);
  }
  return result.output.jokes.at(-1) ?? "";
}

async function main() {
  // Demo 1: runAgent drives the triage machine to completion. It classifies a
  // support ticket and returns a structured { sentiment, category, reply }.
  // onTransition (wired in runTriageDemo) narrates the machine's states.
  console.log("Demo 1: runAgent + generateText (structured triage)");
  console.log("  Classifies a support ticket into { sentiment, category, reply }.");
  const triage = await runTriageDemo("My invoice is wrong and I am furious.");
  console.log("  result:", triage);

  // Demo 2: streaming a joke about state machines, chunks printed live as they
  // arrive (via the onChunk side channel), then the settled final state.
  console.log("\nDemo 2: streamText (live chunks)");
  console.log("  Streaming a joke about state machines, chunks printed live as they arrive:");
  process.stdout.write("  ");
  const joke = await runStreamingDemo("state machines");
  console.log(`  final joke: ${joke}`);
}

runExampleMain(import.meta.url, main);
