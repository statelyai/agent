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
 * Compare `../ai-sdk-game-host/index.ts` for the explicit step-path wiring
 * (`initialAgentStep`/`resolveAgentStep`/`transitionAgentStep`), which is what
 * you reach for when the host — not `runAgent` — owns the loop (e.g. decisions,
 * persistence between steps, a serverless request per turn).
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/ai-sdk-host/index.ts
 */
import { type LanguageModel } from "ai";
import { openai } from "@ai-sdk/openai";
import { createActor, createAsyncLogic, toPromise } from "xstate";
import {
  initialAgentStep,
  resolveAgentStep,
  runAgent,
  validateSchemaSync,
  type AgentTextRequest,
  type AgentTools,
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

// ─── Host Adapter: AI SDK execution ───

interface AiSdkTextHostOptions {
  models?: Record<string, LanguageModel>;
  resolveModel?: (modelRef: string) => LanguageModel;
  onChunk?: (chunk: string, info: { request: AgentTextRequest }) => void;
}

function defaultResolveModel(modelRef: string): LanguageModel {
  return openai(modelRef.replace(/^openai\//, ""));
}

async function generateWithAiSdk(
  input: AgentTextRequest,
  tools: AgentTextRequest["tools"] = input.tools,
  options: AiSdkTextHostOptions = {},
  signal?: AbortSignal,
) {
  const { generateText } = options.models
    ? createAiSdkExecutors({ models: options.models })
    : createAiSdkExecutors({
        resolveModel: options.resolveModel ?? defaultResolveModel,
      });
  const { output } = await generateText({ ...input, tools: tools ?? {} }, { signal });
  return input.outputSchema && typeof output === "string"
    ? validateSchemaSync(input.outputSchema, output)
    : output;
}

async function streamWithAiSdk(
  input: AgentTextRequest,
  options: AiSdkTextHostOptions = {},
  signal?: AbortSignal,
) {
  const { streamText } = options.models
    ? createAiSdkExecutors({ models: options.models })
    : createAiSdkExecutors({
        resolveModel: options.resolveModel ?? defaultResolveModel,
      });
  const { output } = await streamText(
    { ...input, tools: input.tools ?? {} },
    {
      onChunk: options.onChunk
        ? (chunk: string) => options.onChunk!(chunk, { request: input })
        : undefined,
      signal,
    },
  );
  return output;
}

export function createAiSdkTextActor<
  TInputSchema extends StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1,
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
>(
  logic: TextLogic<TInputSchema, TOutputSchema, TMetadata>,
  options: AiSdkTextHostOptions = {},
): TextLogic<TInputSchema, TOutputSchema, TMetadata> {
  return logic.withExecutor(async ({ request, signal }) => ({
    output: (await generateWithAiSdk(request, undefined, options, signal)) as TextLogicOutput<
      typeof logic
    >,
  }));
}

// Module-local: the core `createAiSdkExecutors` is what examples use; this
// hand-rolled variant stays here to keep the file's host-adapter demos
// self-contained.
function createAiSdkTextExecutor(options: AiSdkTextHostOptions = {}) {
  return async (request: AgentTextRequest & { tools: AgentTools }) => ({
    output: await generateWithAiSdk(request, request.tools, options),
  });
}

export function createAiSdkStreamingTextActor<
  TInputSchema extends StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1,
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
>(
  logic: TextLogic<TInputSchema, TOutputSchema, TMetadata>,
  options: AiSdkTextHostOptions = {},
): TextLogic<TInputSchema, TOutputSchema, TMetadata> {
  return logic.withExecutor(async ({ request, signal }) => ({
    output: (await streamWithAiSdk(request, options, signal)) as TextLogicOutput<typeof logic>,
  }));
}

export async function runTriageDemo(ticket: string) {
  const result = await runAgent(triageMachine, {
    input: { ticket },
    generateText: createAiSdkTextExecutor({ models: triageModels }),
    // The host-side observability hook: log each machine transition as it runs.
    onTransition: (snapshot) => console.log(`  state -> ${String(snapshot.value)}`),
  });
  if (result.status !== "done") {
    throw new Error(`Triage demo did not complete: ${result.status}`);
  }
  return result.output;
}

export async function runTriageStepDemo(ticket: string) {
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
      const output = await generateWithAiSdk(request.input, request.tools, {
        models: triageModels,
      });
      step = resolveAgentStep(triageMachine, step, request, output, {
        schemas: triageSchemas,
        actorSources: triageActors,
      });
    }
  }

  return step.snapshot.output;
}

export async function runStreamingDemo(topic: string) {
  const actor = createActor(
    jokeMachine.provide({
      actorSources: {
        tellJoke: createAiSdkStreamingTextActor(tellJoke, {
          models: jokeModels,
          // The side channel: chunks go to stdout as they arrive. In a server
          // this is a UIMessageStream writer or Response stream instead.
          onChunk: (chunk) => process.stdout.write(chunk),
        }),
        "agent.userInput": createAsyncLogic({
          run: async () => ({ feedback: "ok, done" }),
        }),
      },
    }),
    { input: { topic } },
  );
  actor.subscribe((snapshot) => console.log("\n  state ->", JSON.stringify(snapshot.value)));
  actor.start();
  const output = await toPromise(actor);
  process.stdout.write("\n");
  return output.joke;
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

if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  void main();
}
