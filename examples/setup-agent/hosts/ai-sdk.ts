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
  generateObject,
  generateText as aiGenerateText,
  streamText as aiStreamText,
  type FlexibleSchema,
  type LanguageModel,
  type ModelMessage,
} from 'ai';
import { openai } from '@ai-sdk/openai';
import { assign, createActor, initialTransition, toPromise } from 'xstate';
import { z } from 'zod';
import {
  createAgentSchemas,
  setupAgent,
  transitionResult,
  type AgentTextInput,
  type TextLogic,
} from '../../../src/index.js';

// ─── The host adapter: named text logic, implemented with the AI SDK ───

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
    tools,
    toolChoice: input.toolChoice,
  };

  if (input.outputSchema) {
    const { object } = await generateObject({
      ...common,
      schema: input.outputSchema as FlexibleSchema<unknown>,
    });
    return object;
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

export function createAiSdkTextActor<TLogic extends TextLogic>(
  logic: TLogic,
  options: AiSdkTextHostOptions = {}
) {
  return logic.withExecutor(async ({ request, signal }) =>
    await generateWithAiSdk(request, undefined, options, signal) as never
  );
}

export function createAiSdkStreamingTextActor<TLogic extends TextLogic>(
  logic: TLogic,
  options: AiSdkTextHostOptions = {}
) {
  return logic.withExecutor(async ({ request, signal }) =>
    await streamWithAiSdk(request, options, signal) as never
  );
}

// ─── Demo 1: generateText with an object output schema ───

const triageSchema = z.object({
  sentiment: z.enum(['positive', 'neutral', 'negative']),
  category: z.enum(['billing', 'technical', 'other']),
  reply: z.string(),
});

const triageAgent = setupAgent({
  schemas: createAgentSchemas({
    context: z.object({
      ticket: z.string(),
      triage: triageSchema.nullable(),
    }),
    input: z.object({ ticket: z.string() }),
    output: triageSchema,
  }),
}).withTasks({
  triageTicket: {
    schemas: {
      input: z.object({ ticket: z.string() }),
      output: triageSchema,
    },
    model: 'openai/gpt-5.4-nano',
    system:
      'Triage the support ticket: sentiment, category, and a short suggested reply.',
    prompt: ({ input }) => input.ticket,
  },
});

const { triageTicket } = triageAgent.tasks;

const triageMachine = triageAgent.createMachine({
  id: 'ticket-triage',
  context: ({ input }) => ({ ticket: input.ticket, triage: null }),
  initial: 'triaging',
  states: {
    triaging: {
      invoke: {
        id: 'triage',
        src: 'triageTicket',
        input: ({ context }) => ({ ticket: context.ticket }),
        onDone: {
          target: 'done',
          actions: assign({
            triage: ({ event }) => event.output,
          }),
        },
      },
    },
    done: {
      type: 'final',
      output: ({ context }) =>
        context.triage ?? { sentiment: 'neutral', category: 'other', reply: '' },
    },
  },
});

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

export async function runTriagePureTransitionDemo(ticket: string) {
  let [snapshot, actions] = initialTransition(triageMachine, { ticket });

  while (snapshot.status !== 'done') {
    const effects = triageMachine.getTasks(actions, snapshot);
    if (effects.length === 0) {
      throw new Error('Machine is waiting without an agent effect.');
    }

    for (const effect of effects) {
      const output = await triageMachine.execute(effect, {
        generateObject: (request) =>
          generateWithAiSdk(request, request.tools),
        generateText: (request) =>
          generateWithAiSdk(request, request.tools),
      });
      [snapshot, actions] = transitionResult(
        triageMachine,
        snapshot,
        effect,
        output
      );
    }
  }

  return snapshot.output;
}

// ─── Demo 2: streamText actually streaming ───

const jokeAgent = setupAgent({
  schemas: createAgentSchemas({
    context: z.object({
      topic: z.string(),
      joke: z.string().nullable(),
    }),
    input: z.object({ topic: z.string() }),
    output: z.object({ joke: z.string() }),
  }),
}).withTasks({
  tellJoke: {
    kind: 'stream',
    schemas: {
      input: z.object({ topic: z.string() }),
      output: z.string(),
    },
    model: 'openai/gpt-5.4-nano',
    system: 'You tell short, punchy jokes.',
    prompt: ({ input }) => `Tell a joke about ${input.topic}.`,
  },
});

const { tellJoke } = jokeAgent.tasks;

const jokeMachine = jokeAgent.createMachine({
  id: 'joke-streamer',
  context: ({ input }) => ({ topic: input.topic, joke: null }),
  // The no-helper route to typed machine output: a root-level `output`
  // mapper, which XState types against the output schema natively. Final
  // states stay bare. (`agent.final` is only needed when each final state
  // computes a DIFFERENT output.)
  output: ({ context }) => ({ joke: context.joke ?? '' }),
  initial: 'streaming',
  states: {
    streaming: {
      invoke: {
        id: 'joke',
        src: 'tellJoke',
        input: ({ context }) => ({ topic: context.topic }),
        onDone: {
          target: 'done',
          // event.output is the FINAL streamed text (string)
          actions: assign({ joke: ({ event }) => event.output }),
        },
      },
    },
    done: { type: 'final' },
  },
});

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
