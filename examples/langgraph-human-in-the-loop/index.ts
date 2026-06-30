import assert from 'node:assert/strict';
import { z } from 'zod';
import { createActor, createAsyncLogic, toPromise, waitFor } from 'xstate';
import { setupAgent } from '../../src/index.js';

export async function runLangGraphHumanInTheLoopExample() {
  const agent = setupAgent({
    context: z.object({
      topic: z.string(),
      draft: z.string().nullable(),
    }),
    input: z.object({ topic: z.string() }),
    output: z.object({ published: z.boolean(), draft: z.string() }),
    events: {
      APPROVE: z.object({}),
      REJECT: z.object({ reason: z.string() }),
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
    id: 'raw-xstate-hitl',
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
        on: {
          APPROVE: { target: 'published' },
          REJECT: ({ context, event }) => ({
            target: 'drafting',
            context: {
              topic: `${context.topic}\nRevision: ${(event as unknown as { reason: string }).reason}`,
            },
          }),
        },
      },
      published: {
        type: 'final',
        output: ({ context }) => ({
          published: true,
          draft: context.draft ?? '',
        }),
      },
    },
  });

  const actor = createActor(
    machine.provide({
      actorSources: {
        writeDraft: agent.requests.writeDraft.withExecutor(
          async ({ input }) => `Draft: ${input.topic}`,
        ),
      },
    }),
    { input: { topic: 'release notes' } },
  );

  actor.start();
  await waitFor(actor, (snapshot) => snapshot.matches('reviewing'));
  actor.send({ type: 'APPROVE' });
  await waitFor(actor, (snapshot) => snapshot.status === 'done');

  assert.deepEqual(actor.getSnapshot().output, {
    published: true,
    draft: 'Draft: release notes',
  });
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  await runLangGraphHumanInTheLoopExample();
}
