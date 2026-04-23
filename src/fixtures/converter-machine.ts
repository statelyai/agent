import { z } from 'zod';
import { createAgentMachine } from '../index.js';

declare function unknownTransition(): { target: 'done' };

export const namedMachine = createFixtureMachine('named-converter-machine');

export const warningMachine = createAgentMachine({
  id: 'warning-converter-machine',
  schemas: {
    events: {
      go: z.object({
        type: z.literal('go'),
      }),
    },
  },
  context: () => ({}),
  initial: 'idle',
  states: {
    idle: {
      on: {
        go: () => unknownTransition(),
      },
    },
    done: {
      type: 'final',
    },
  },
});

export default createFixtureMachine('default-converter-machine');

export function createFixtureMachine(id = 'factory-converter-machine') {
  return createAgentMachine({
    id,
    schemas: {
      events: {
        submit: z.object({
          type: z.literal('submit'),
          ok: z.boolean(),
        }),
      },
    },
    context: () => ({
      approved: false,
    }),
    initial: 'idle',
    states: {
      idle: {
        on: {
          submit: ({ event }) =>
            event.ok
              ? {
                  target: 'done',
                  context: { approved: true },
                }
              : { target: 'rejected' },
        },
      },
      rejected: {
        type: 'final',
      },
      done: {
        type: 'final',
      },
    },
  });
}
