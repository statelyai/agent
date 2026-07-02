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
import {
  generateText as aiGenerateText,
  Output,
  streamText as aiStreamText,
  type FlexibleSchema,
  type LanguageModel,
  type ModelMessage,
} from 'ai';
import { openai } from '@ai-sdk/openai';
import {
  createActor,
  createAsyncLogic,
  toPromise,
} from 'xstate';
import {
  initialAgentStep,
  isStructuredOutputSchema,
  resolveAgentStep,
  runAgent,
  type AgentTextRequest,
  type AgentTools,
  type StandardSchemaV1,
  type TextLogic,
  type TextLogicOutput,
  validateSchemaSync,
} from '../../src/index.js';
import { toAiSdkTools } from '../../src/ai-sdk/index.js';
import { jokeActors, jokeMachine, tellJoke } from '../joke/index.js';
import { triageActors, triageMachine, triageSchemas, triageTicket } from '../triage/index.js';

// ─── Host Adapter: AI SDK execution ───

interface AiSdkTextHostOptions {
  resolveModel?: (modelRef: string) => LanguageModel;
  onChunk?: (chunk: string) => void;
}

function resolveAiSdkModel(
  modelRef: string,
  options: AiSdkTextHostOptions
): LanguageModel {
  return options.resolveModel
    ? options.resolveModel(modelRef)
    : openai(modelRef.replace(/^openai\//, ''));
}

function toModelMessages(input: AgentTextRequest): ModelMessage[] | undefined {
  return input.messages as ModelMessage[] | undefined;
}

async function generateWithAiSdk(
  input: AgentTextRequest,
  tools: AgentTextRequest['tools'] = input.tools,
  options: AiSdkTextHostOptions = {},
  signal?: AbortSignal
) {
  const model = resolveAiSdkModel(input.model, options);
  const messages = toModelMessages(input);
  const common = {
    model,
    system: input.system,
    ...(messages ? { messages } : { prompt: input.prompt ?? '' }),
    abortSignal: signal,
    temperature: input.temperature,
    maxOutputTokens: input.maxTokens,
    topP: input.topP,
    seed: input.seed,
    stopSequences: input.stopSequences,
    tools: tools ? toAiSdkTools(tools) : undefined,
    toolChoice: typeof input.toolChoice === 'object'
      ? { type: 'tool' as const, toolName: input.toolChoice.name }
      : input.toolChoice,
  };

  if (isStructuredOutputSchema(input.outputSchema)) {
    const { output } = await aiGenerateText({
      ...common,
      output: Output.object({
        schema: input.outputSchema as FlexibleSchema<unknown>,
      }),
    });
    return output;
  }

  const { text } = await aiGenerateText(common);
  return input.outputSchema
    ? validateSchemaSync(input.outputSchema, text)
    : text;
}

async function streamWithAiSdk(
  input: AgentTextRequest,
  options: AiSdkTextHostOptions = {},
  signal?: AbortSignal
) {
  const model = resolveAiSdkModel(input.model, options);
  const messages = toModelMessages(input);

  const result = aiStreamText({
    model,
    system: input.system,
    ...(messages ? { messages } : { prompt: input.prompt ?? '' }),
    abortSignal: signal,
    temperature: input.temperature,
    maxOutputTokens: input.maxTokens,
    topP: input.topP,
    seed: input.seed,
    stopSequences: input.stopSequences,
  });

  for await (const chunk of result.textStream) {
    options.onChunk?.(chunk);
  }

  return await result.text;
}

export function createAiSdkTextActor<
  TInputSchema extends StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1,
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
>(
  logic: TextLogic<TInputSchema, TOutputSchema, TMetadata>,
  options: AiSdkTextHostOptions = {}
): TextLogic<TInputSchema, TOutputSchema, TMetadata> {
  return logic.withExecutor(async ({ request, signal }) =>
    await generateWithAiSdk(request, undefined, options, signal) as TextLogicOutput<typeof logic>
  );
}

export function createAiSdkTextExecutor(options: AiSdkTextHostOptions = {}) {
  return (request: AgentTextRequest & { tools: AgentTools }) =>
    generateWithAiSdk(request, request.tools, options);
}

export function createAiSdkStreamingTextActor<
  TInputSchema extends StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1,
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
>(
  logic: TextLogic<TInputSchema, TOutputSchema, TMetadata>,
  options: AiSdkTextHostOptions = {}
): TextLogic<TInputSchema, TOutputSchema, TMetadata> {
  return logic.withExecutor(async ({ request, signal }) =>
    await streamWithAiSdk(request, options, signal) as TextLogicOutput<typeof logic>
  );
}

export async function runTriageDemo(ticket: string) {
  return await runAgent(triageMachine, {
    input: { ticket },
    generateText: createAiSdkTextExecutor(),
    schemas: triageSchemas,
    actors: triageActors,
  });
}

export async function runTriageStepDemo(ticket: string) {
  let step = initialAgentStep(triageMachine, { ticket }, {
    schemas: triageSchemas,
    actors: triageActors,
  });

  while (!step.done) {
    if (step.requests.length === 0) {
      throw new Error('Machine is waiting without an agent request.');
    }

    for (const request of step.requests) {
      const output = await generateWithAiSdk(
        request.input,
        request.tools
      );
      step = resolveAgentStep(
        triageMachine,
        step,
        request,
        output,
        {
          schemas: triageSchemas,
          actors: triageActors,
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
