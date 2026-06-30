import assert from 'node:assert/strict';
import { z } from 'zod';
import { createActor, createAsyncLogic, toPromise, waitFor } from 'xstate';
import { setupAgent } from '../../src/index.js';

export async function runLangGraphSnapshotPersistenceExample() {
  const agent = setupAgent({
    context: z.object({
      topic: z.string(),
      draft: z.string().nullable(),
    }),
    input: z.object({ topic: z.string() }),
    output: z.object({ draft: z.string() }),
    events: {
      APPROVE: z.object({}),
    },
    requests: {
      writeDraft: {
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
    id: 'raw-xstate-persistence',
    context: ({ input }) => ({ topic: input.topic, draft: null }),
    initial: 'drafting',
    states: {
      drafting: {
        invoke: {
          src: 'writeDraft',
          input: ({ context }: { context: { topic: string } }) => ({
            topic: context.topic,
          }),
          onDone: ({ output }) => ({
            target: 'reviewing',
            context: { draft: output },
          }),
        },
      },
      reviewing: {
        on: { APPROVE: { target: 'done' } },
      },
      done: {
        type: 'final',
        output: ({ context }) => ({ draft: context.draft ?? '' }),
      },
    },
  });

  const actors = {
    writeDraft: agent.requests.writeDraft.withExecutor(
      async ({ input }) => `Draft: ${input.topic}`,
    ),
  };
  const first = createActor(machine.provide({ actorSources: actors }), {
    input: { topic: 'incident update' },
  });
  first.start();
  await waitFor(first, (snapshot) => snapshot.matches('reviewing'));

  const persisted = first.getPersistedSnapshot();
  first.stop();

  const restored = createActor(machine.provide({ actorSources: actors }), {
    input: { topic: 'incident update' },
    snapshot: persisted,
  });
  restored.start();
  restored.send({ type: 'APPROVE' });
  await toPromise(restored);

  assert.deepEqual(restored.getSnapshot().output, {
    draft: 'Draft: incident update',
  });
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  await runLangGraphSnapshotPersistenceExample();
}
