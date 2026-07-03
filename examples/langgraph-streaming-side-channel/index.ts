import assert from 'node:assert/strict';
import { z } from 'zod';
import { runAgent, setupAgent } from '../../src/index.js';
const models = {
  "writer": "writer",
} as const;


export async function runLangGraphStreamingSideChannelExample() {
  const chunks: string[] = [];
  const agent = setupAgent({
    models,
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

  // A `mode: 'stream'` request is executed by runAgent's `streamText`
  // executor instead of `generateText`. The executor streams chunks by
  // calling `info.onChunk`; runAgent forwards each one to the host's
  // `onChunk(chunk, { request })` — the "side channel" — instead of the
  // machine collecting chunks itself.
  const result = await runAgent(machine, {
    input: { topic: 'agents' },
    generateText: async () => ({}),
    streamText: async (request, info) => {
      info?.onChunk?.('hello');
      info?.onChunk?.(request.prompt ?? '');
      return `hello ${request.prompt ?? ''}`;
    },
    onChunk: (chunk) => {
      chunks.push(chunk);
    },
  });

  assert.equal(result.status, 'done');
  assert.deepEqual(chunks, ['hello', 'agents']);
  assert.deepEqual(result.status === 'done' ? result.output : undefined, {
    text: 'hello agents',
  });
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  await runLangGraphStreamingSideChannelExample();
}
