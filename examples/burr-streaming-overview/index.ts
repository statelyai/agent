/**
 * Burr Streaming Overview — safety check, mode routing, streamed answer.
 *
 * Burr's `streaming-overview` example checks input safety, routes to a
 * response mode, then streams the answer back token by token. Here
 * `answerPrompt` is a co-located request in `mode: 'stream'`; the host
 * supplies a `streamText` executor and observes chunks via `runAgent`'s
 * `onChunk(chunk, { request })` callback instead of the executor collecting
 * chunks into a closure array by hand.
 */
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  runAgent,
  setupAgent,
  type AgentRequestExecutorInfo,
  type AgentTextRequest,
  type AgentTools,
} from '../../src/index.js';
const models = {
  "mode-router": "mode-router",
  "streaming-writer": "streaming-writer",
} as const;


export async function runBurrStreamingOverviewExample() {
  const modeSchema = z.object({
    mode: z.enum([
      'answer_question',
      'generate_code',
      'generate_image',
      'unknown',
    ]),
  });
  const agent = setupAgent({
    models,
    context: z.object({
      prompt: z.string(),
      safe: z.boolean(),
      mode: modeSchema.shape.mode.nullable(),
      response: z.string().nullable(),
    }),
    input: z.object({ prompt: z.string() }),
    output: z.object({ response: z.string() }),
    requests: {
      chooseMode: {
        schemas: {
          input: z.object({ prompt: z.string() }),
          output: modeSchema,
        },
        model: 'mode-router',
        system: 'Choose the response mode.',
        prompt: ({ input }) => input.prompt,
      },
      answerPrompt: {
        mode: 'stream',
        schemas: {
          input: z.object({
            prompt: z.string(),
            mode: modeSchema.shape.mode,
          }),
          output: z.string(),
        },
        model: 'streaming-writer',
        prompt: ({ input }) => `${input.mode}:${input.prompt}`,
      },
    },
  });

  const machine = agent.createMachine({
    id: 'burr-streaming-router-xstate',
    context: ({ input }) => ({
      prompt: input.prompt,
      safe: false,
      mode: null,
      response: null,
    }),
    initial: 'checkSafety',
    states: {
      checkSafety: {
        type: 'choice',
        choice: ({ context }) =>
          !context.prompt.includes('unsafe')
            ? { target: 'decideMode', context: { safe: true } }
            : { target: 'unsafeResponse', context: { safe: false } },
      },
      decideMode: {
        invoke: {
          src: 'chooseMode',
          input: ({ context }) => ({ prompt: context.prompt }),
          onDone: ({ output }) => ({
            target: 'route',
            context: { mode: output.mode },
          }),
        },
      },
      route: {
        type: 'choice',
        choice: ({ context }) =>
          context.mode === 'unknown'
            ? { target: 'promptForMore' }
            : { target: 'answering' },
      },
      answering: {
        invoke: {
          src: 'answerPrompt',
          input: ({ context }) => ({
            prompt: context.prompt,
            mode: context.mode ?? 'answer_question',
          }),
          onDone: ({ output }) => ({
            target: 'done',
            context: { response: output },
          }),
        },
      },
      promptForMore: {
        type: 'choice',
        choice: () => ({
          target: 'done',
          context: { response: 'Please clarify.' },
        }),
      },
      unsafeResponse: {
        type: 'choice',
        choice: () => ({
          target: 'done',
          context: { response: 'I cannot respond to that.' },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({ response: context.response ?? '' }),
      },
    },
  });

  const generateText = async () => ({ object: { mode: 'generate_code' } });

  // answerPrompt's prompt is `${mode}:${prompt}` (see requests.answerPrompt above).
  const streamText = async (
    request: AgentTextRequest & { tools: AgentTools },
    info?: AgentRequestExecutorInfo
  ) => {
    info?.onChunk?.('chunk:1');
    info?.onChunk?.('chunk:2');
    return { text: `response:${request.prompt}` };
  };

  const chunks: string[] = [];
  const result = await runAgent(machine, {
    input: { prompt: 'write a TypeScript function' },
    generateText,
    streamText,
    onChunk: (chunk) => chunks.push(chunk),
  });

  if (result.status !== 'done') {
    throw new Error(`Streaming overview example did not complete: ${result.status}`);
  }
  assert.deepEqual(chunks, ['chunk:1', 'chunk:2']);
  assert.deepEqual(result.output, {
    response: 'response:generate_code:write a TypeScript function',
  });
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  await runBurrStreamingOverviewExample();
}
