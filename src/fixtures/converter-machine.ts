import { z } from 'zod';
import { createAgentMachine } from '../index.js';

export const namedMachine = createFixtureMachine('named-converter-machine');

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
