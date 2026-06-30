import assert from 'node:assert/strict';
import { z } from 'zod';
import { createActor, createAsyncLogic, toPromise, waitFor } from 'xstate';
import { setupAgent } from '../../src/index.js';

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
        entry: ({ context }) => ({
          context: { safe: !context.prompt.includes('unsafe') },
        }),
        always: ({ context }) =>
          context.safe
            ? { target: 'decideMode' }
            : { target: 'unsafeResponse' },
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
        always: ({ context }) =>
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
        entry: () => ({ context: { response: 'Please clarify.' } }),
        always: { target: 'done' },
      },
      unsafeResponse: {
        entry: () => ({ context: { response: 'I cannot respond to that.' } }),
        always: { target: 'done' },
      },
      done: {
        type: 'final',
        output: ({ context }) => ({ response: context.response ?? '' }),
      },
    },
  });

  const chunks: string[] = [];
  const actor = createActor(
    machine.provide({
      actorSources: {
        chooseMode: agent.requests.chooseMode.withExecutor(async () => ({
          mode: 'generate_code',
        })),
        answerPrompt: agent.requests.answerPrompt.withExecutor(
          async ({ input }) => {
            chunks.push('chunk:1');
            chunks.push('chunk:2');
            return `response:${input.mode}:${input.prompt}`;
          },
        ),
      },
    }),
    { input: { prompt: 'write a TypeScript function' } },
  );
  actor.start();
  await toPromise(actor);

  assert.deepEqual(chunks, ['chunk:1', 'chunk:2']);
  assert.deepEqual(actor.getSnapshot().output, {
    response: 'response:generate_code:write a TypeScript function',
  });
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  await runBurrStreamingOverviewExample();
}
