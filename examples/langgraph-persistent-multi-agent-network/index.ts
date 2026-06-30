import assert from 'node:assert/strict';
import { z } from 'zod';
import { createActor, createAsyncLogic, toPromise, waitFor } from 'xstate';
import { setupAgent } from '../../src/index.js';

export async function runLangGraphPersistentMultiAgentNetworkExample() {
  const agent = setupAgent({
    context: z.object({
      topic: z.string(),
      research: z.string().nullable(),
      draft: z.string().nullable(),
    }),
    input: z.object({ topic: z.string() }),
    output: z.object({ draft: z.string() }),
    events: {
      CONTINUE: z.object({}),
    },
    actors: {
      research: createAsyncLogic<string, { topic: string }>({
        run: async ({ input }) => `research:${input.topic}`,
      }),
      write: createAsyncLogic<string, { research: string }>({
        run: async ({ input }) => `draft:${input.research}`,
      }),
    },
  });

  const machine = agent.createMachine({
    id: 'raw-xstate-persistent-network',
    context: ({ input }) => ({
      topic: input.topic,
      research: null,
      draft: null,
    }),
    initial: 'researching',
    states: {
      researching: {
        invoke: {
          src: 'research',
          input: ({ context }) => ({ topic: context.topic }),
          onDone: ({ output }) => ({
            target: 'waitingToWrite',
            context: { research: output },
          }),
        },
      },
      waitingToWrite: {
        on: { CONTINUE: { target: 'writing' } },
      },
      writing: {
        invoke: {
          src: 'write',
          input: ({ context }) => ({ research: context.research ?? '' }),
          onDone: ({ output }) => ({
            target: 'done',
            context: { draft: output },
          }),
        },
      },
      done: {
        type: 'final',
        output: ({ context }) => ({ draft: context.draft ?? '' }),
      },
    },
  });

  const first = createActor(machine, { input: { topic: 'xstate' } });
  first.start();
  await waitFor(first, (snapshot) => snapshot.matches('waitingToWrite'));
  const persisted = first.getPersistedSnapshot();
  first.stop();

  const restored = createActor(machine, {
    input: { topic: 'xstate' },
    snapshot: persisted,
  });
  restored.start();
  restored.send({ type: 'CONTINUE' });
  await toPromise(restored);

  assert.deepEqual(restored.getSnapshot().output, {
    draft: 'draft:research:xstate',
  });
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  await runLangGraphPersistentMultiAgentNetworkExample();
}
