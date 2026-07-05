/**
 * Vercel AI SDK host for XState agent machines.
 *
 * The machine declares named text logic calls; this host provides their
 * execution with the AI SDK. Streaming chunks flow through the host side
 * channel (`onChunk` → stdout, HTTP stream, etc.) — the machine itself only
 * transitions on the final text.
 *
 * Run: OPENAI_API_KEY=... node --import tsx examples/ai-sdk-host/index.ts
 */
import { type LanguageModel } from 'ai';
import { openai } from '@ai-sdk/openai';
import {
  createActor,
  createAsyncLogic,
  toPromise,
} from 'xstate';
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
} from '../../src/index.js';
import { createAiSdkExecutors } from '../../src/ai-sdk/index.js';
import { jokeActors, jokeMachine, models as jokeModels, tellJoke } from '../joke/index.js';
import { models as triageModels, triageActors, triageMachine, triageSchemas, triageTicket } from '../triage/index.js';

// ─── Host Adapter: AI SDK execution ───

interface AiSdkTextHostOptions {
  models?: Record<string, LanguageModel>;
  resolveModel?: (modelRef: string) => LanguageModel;
  onChunk?: (chunk: string, info: { request: AgentTextRequest }) => void;
}

function defaultResolveModel(modelRef: string): LanguageModel {
  return openai(modelRef.replace(/^openai\//, ''));
}

async function generateWithAiSdk(
  input: AgentTextRequest,
  tools: AgentTextRequest['tools'] = input.tools,
  options: AiSdkTextHostOptions = {},
  signal?: AbortSignal
) {
  const { generateText } = options.models
    ? createAiSdkExecutors({ models: options.models })
    : createAiSdkExecutors({
        resolveModel: options.resolveModel ?? defaultResolveModel,
      });
  const { output } = await generateText({ ...input, tools: tools ?? {} }, { signal });
  return input.outputSchema && typeof output === 'string'
    ? validateSchemaSync(input.outputSchema, output)
    : output;
}

async function streamWithAiSdk(
  input: AgentTextRequest,
  options: AiSdkTextHostOptions = {},
  signal?: AbortSignal
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
    }
  );
  return output;
}

export function createAiSdkTextActor<
  TInputSchema extends StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1,
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
>(
  logic: TextLogic<TInputSchema, TOutputSchema, TMetadata>,
  options: AiSdkTextHostOptions = {}
): TextLogic<TInputSchema, TOutputSchema, TMetadata> {
  return logic.withExecutor(async ({ request, signal }) => ({
    output: await generateWithAiSdk(request, undefined, options, signal) as TextLogicOutput<typeof logic>,
  }));
}

export function createAiSdkTextExecutor(options: AiSdkTextHostOptions = {}) {
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
  options: AiSdkTextHostOptions = {}
): TextLogic<TInputSchema, TOutputSchema, TMetadata> {
  return logic.withExecutor(async ({ request, signal }) => ({
    output: await streamWithAiSdk(request, options, signal) as TextLogicOutput<typeof logic>,
  }));
}

export async function runTriageDemo(ticket: string) {
  const result = await runAgent(triageMachine, {
    input: { ticket },
    generateText: createAiSdkTextExecutor({ models: triageModels }),
  });
  if (result.status !== 'done') {
    throw new Error(`Triage demo did not complete: ${result.status}`);
  }
  return result.output;
}

export async function runTriageStepDemo(ticket: string) {
  let step = initialAgentStep(triageMachine, { ticket }, {
    schemas: triageSchemas,
    actorSources: triageActors,
  });

  while (!step.done) {
    if (step.requests.length === 0) {
      throw new Error('Machine is waiting without an agent request.');
    }

    for (const request of step.requests) {
      if (request.kind !== 'text') {
        throw new Error('Decision requests are not supported in this demo.');
      }
      const output = await generateWithAiSdk(
        request.input,
        request.tools,
        { models: triageModels }
      );
      step = resolveAgentStep(
        triageMachine,
        step,
        request,
        output,
        {
          schemas: triageSchemas,
          actorSources: triageActors,
        }
      );
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
        'agent.userInput': createAsyncLogic({
          run: async () => ({ feedback: 'ok, done' }),
        }),
      },
    }),
    { input: { topic } }
  );
  actor.start();
  await toPromise(actor);
  process.stdout.write('\n');
}

async function main() {
  console.log('— generateText (object output) —');
  console.log(await runTriageDemo('My invoice is wrong and I am furious.'));
  console.log('— streamText (live chunks) —');
  await runStreamingDemo('state machines');
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('Set OPENAI_API_KEY to run this example.');
  }
  void main();
}
