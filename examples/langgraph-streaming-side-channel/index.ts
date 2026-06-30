import assert from 'node:assert/strict';
import { z } from 'zod';
import { createActor, createAsyncLogic, toPromise, waitFor } from 'xstate';
import { setupAgent } from '../../src/index.js';

export async function runLangGraphStreamingSideChannelExample() {
  const chunks: string[] = [];
  const agent = setupAgent({
    context: z.object({ topic: z.string(), text: z.string().nullable() }),
    input: z.object({ topic: z.string() }),
    output: z.object({ text: z.string() }),
    requests: {
      streamTopic: {
        mode: 'stream',
        schemas: {
          input: z.object({ topic: z.string() }),
          output: z.string(),
        },
        model: 'writer',
        prompt: ({ input }) => input.topic,
      },
    },
  });

  const machine = agent.createMachine({
    id: 'raw-xstate-streaming',
    context: ({ input }) => ({ topic: input.topic, text: null }),
    initial: 'streaming',
    states: {
      streaming: {
        invoke: {
          src: 'streamTopic',
          input: ({ context }) => ({ topic: context.topic }),
          onDone: ({ output }) => ({
            target: 'done',
            context: { text: output },
          }),
        },
      },
      done: {
        type: 'final',
        output: ({ context }) => ({ text: context.text ?? '' }),
      },
    },
  });

  const actor = createActor(
    machine.provide({
      actorSources: {
        streamTopic: agent.requests.streamTopic.withExecutor(
          async ({ input }) => {
            chunks.push('hello');
            chunks.push(input.topic);
            return chunks.join(' ');
          },
        ),
      },
    }),
    { input: { topic: 'agents' } },
  );
  actor.start();
  await toPromise(actor);

  assert.deepEqual(chunks, ['hello', 'agents']);
  assert.deepEqual(actor.getSnapshot().output, { text: 'hello agents' });
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  await runLangGraphStreamingSideChannelExample();
}
