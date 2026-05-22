import { describe, expect, test, vi } from 'vitest';
import { execute, invoke, stream } from '../local/index.js';
import { createMultiAgentNetworkExample } from '../../examples/multi-agent-network.js';

test('multi-agent network coordinates specialist handoffs until a final draft is ready', async () => {
  let step = 0;

  const machine = createMultiAgentNetworkExample({
    adapter: {
      decide: async () => {
        step += 1;

        if (step === 1) {
          return {
            choice: 'research',
            data: { focus: 'collect architecture notes' },
          };
        }

        if (step === 2) {
          return {
            choice: 'write',
            data: { angle: 'turn notes into an executive summary' },
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
  });

  const result = await execute(machine, 
    machine.getInitialState({ topic: 'agent runtimes' })
  );

  expect(result.status).toBe('done');
  if (result.status === 'done') {
    expect(result.output).toEqual({
      topic: 'agent runtimes',
      notes: [
        'agent runtimes:collect architecture notes:1',
        'agent runtimes:collect architecture notes:2',
      ],
      draft:
        'agent runtimes | turn notes into an executive summary | agent runtimes:collect architecture notes:1 / agent runtimes:collect architecture notes:2',
      handoffs: [
        'researcher:collect architecture notes',
        'writer:turn notes into an executive summary',
      ],
    });
  }
});
