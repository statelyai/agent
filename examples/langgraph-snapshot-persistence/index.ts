import assert from 'node:assert/strict';
import { z } from 'zod';
import { runAgent, setupAgent } from '../../src/index.js';
const models = {
  "writer": "writer",
} as const;


export async function runLangGraphSnapshotPersistenceExample() {
  const agent = setupAgent({
    models,
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
          input: ({ context }) => ({
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

  const generateText = async (request: { prompt?: string }) => ({ output: `Draft: ${request.prompt ?? ''}` });

  // No invoke in `reviewing`, nothing in flight: runAgent settles idle
  // instead of blocking. Persist the snapshot (host's choice of store) —
  // JSON round-trip it here to prove it survives a real persistence layer.
  const first = await runAgent(machine, {
    input: { topic: 'incident update' },
    generateText,
  });

  assert.equal(first.status, 'idle');
  const persisted = JSON.parse(JSON.stringify(first.snapshot));

  // ...later, new process, human approved...
  const second = await runAgent(machine, {
    snapshot: persisted,
    event: { type: 'APPROVE' },
    generateText,
  });

  assert.equal(second.status, 'done');
  assert.deepEqual(second.status === 'done' ? second.output : undefined, {
    draft: 'Draft: incident update',
  });
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  await runLangGraphSnapshotPersistenceExample();
}
