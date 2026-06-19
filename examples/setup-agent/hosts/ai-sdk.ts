/**
 * Vercel AI SDK host for `setupAgent(...)` machines.
 *
 * The machine declares named text logic calls; this host provides their
 * execution with the AI SDK. Streaming chunks flow through the host side
 * channel (`onChunk` → stdout, HTTP stream, etc.) — the machine itself only
 * transitions on the final text.
 *
 * Run: OPENAI_API_KEY=... node --import tsx examples/setup-agent/hosts/ai-sdk.ts
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
import { createActor, toPromise } from 'xstate';
import {
  type AgentTextInput,
  type AgentTools,
  type TextLogicExecutor,
} from '../../../src/index.js';
import { toAiSdkTools } from '../../../src/ai-sdk/index.js';
import { jokeMachine, tellJoke } from '../joke.js';
import { triageMachine, triageTicket } from '../triage.js';

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

function toModelMessages(input: AgentTextInput): ModelMessage[] | undefined {
  return input.messages?.map((message) => ({
    role: message.role as 'user' | 'assistant' | 'system',
    content: message.content,
  }));
}

async function generateWithAiSdk(
  input: AgentTextInput,
  tools: AgentTextInput['tools'] = input.tools,
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

  if (input.outputSchema) {
    const { output } = await aiGenerateText({
      ...common,
      output: Output.object({
        schema: input.outputSchema as FlexibleSchema<unknown>,
      }),
    });
    return output;
  }

  const { text } = await aiGenerateText(common);
  return text;
}

async function streamWithAiSdk(
  input: AgentTextInput,
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

type ExecutableTextLogic = {
  withExecutor(execute: TextLogicExecutor<any, any, any>): unknown;
};

export function createAiSdkTextActor<TLogic extends ExecutableTextLogic>(
  logic: TLogic,
  options: AiSdkTextHostOptions = {}
) {
  return logic.withExecutor(async ({ request, signal }) =>
    await generateWithAiSdk(request, undefined, options, signal) as never
  );
}

export function createAiSdkStreamingTextActor<TLogic extends ExecutableTextLogic>(
  logic: TLogic,
  options: AiSdkTextHostOptions = {}
) {
  return logic.withExecutor(async ({ request, signal }) =>
    await streamWithAiSdk(request, options, signal) as never
  );
}

export async function runTriageDemo(ticket: string) {
  const actor = createActor(
    triageMachine.provide({
      actors: {
        triageTicket: createAiSdkTextActor(triageTicket),
      },
    }),
    { input: { ticket } }
  );
  actor.start();
  const output = await toPromise(actor);
  return output; // machine output, typed by the output schema
}

export async function runTriageStepDemo(ticket: string) {
  let step = triageMachine.initial({ ticket });

  while (!step.done) {
    if (step.tasks.length === 0) {
      throw new Error('Machine is waiting without an agent task.');
    }

    for (const task of step.tasks) {
      const output = await triageMachine.execute(task, {
        generateText: (request: AgentTextInput & { tools: AgentTools }) =>
          generateWithAiSdk(request, request.tools),
      });
      step = triageMachine.resolve(step, task, output);
    }
  }

  return step.snapshot.output;
}

export async function runStreamingDemo(topic: string) {
  const actor = createActor(
    jokeMachine.provide({
      actors: {
        tellJoke: createAiSdkStreamingTextActor(tellJoke, {
          // The side channel: chunks go to stdout as they arrive. In a server
          // this is a UIMessageStream writer or Response stream instead.
          onChunk: (chunk) => process.stdout.write(chunk),
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

if (process.env.OPENAI_API_KEY) {
  void main();
}
