import { expect, test } from 'vitest';
import { runPersistentMultiAgentNetworkExample } from '../../examples/index.js';

test('restores a multi-agent handoff workflow from a persisted mid-handoff snapshot', async () => {
  let step = 0;

  const result = await runPersistentMultiAgentNetworkExample(
    { topic: 'durable agent handoffs' },
    {
      adapter: {
        decide: async () => {
          step += 1;

          if (step === 1) {
            return {
              choice: 'research',
              data: { focus: 'collect the most durable architecture notes' },
            };
          }

          if (step === 2) {
            return {
              choice: 'write',
              data: { angle: 'summarize the handoff-ready findings' },
            };
          }

          return {
            choice: 'finalize',
            data: {},
          };
        },
      },
      research: async ({ topic, focus }) => ({
        notes: [`${topic}:${focus}:1`, `${topic}:${focus}:2`],
      }),
      write: async ({ topic, notes, angle }) => ({
        draft: `${topic} | ${angle} | ${notes.join(' / ')}`,
      }),
    }
  );

  expect(result.restoredSnapshot).toEqual(result.liveSnapshot);
  expect(result.restoredSnapshot).toEqual(
    expect.objectContaining({
      value: 'done',
      status: 'done',
      output: {
        topic: 'durable agent handoffs',
        notes: [
          'durable agent handoffs:collect the most durable architecture notes:1',
          'durable agent handoffs:collect the most durable architecture notes:2',
        ],
        draft:
          'durable agent handoffs | summarize the handoff-ready findings | durable agent handoffs:collect the most durable architecture notes:1 / durable agent handoffs:collect the most durable architecture notes:2',
        handoffs: [
          'researcher:collect the most durable architecture notes',
          'writer:summarize the handoff-ready findings',
        ],
      },
    })
  );
});
