import assert from 'node:assert/strict';
import { z } from 'zod';
import { createAsyncLogic } from 'xstate';
import { runAgent, setupAgent } from '../../src/index.js';

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
    actorSources: {
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

  // No invoke in `waitingToWrite`, nothing in flight: runAgent settles idle
  // instead of blocking. Persist the snapshot (host's choice of store) —
  // JSON round-trip it here to prove it survives a real persistence layer.
  const first = await runAgent(machine, {
    input: { topic: 'xstate' },
  });

  assert.equal(first.status, 'idle');
  const persisted = JSON.parse(JSON.stringify(first.snapshot));

  // ...later, new process, the network continues...
  const second = await runAgent(machine, {
    snapshot: persisted,
    event: { type: 'CONTINUE' },
  });

  assert.equal(second.status, 'done');
  assert.deepEqual(second.status === 'done' ? second.output : undefined, {
    draft: 'draft:research:xstate',
  });
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  await runLangGraphPersistentMultiAgentNetworkExample();
}
