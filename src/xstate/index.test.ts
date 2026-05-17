import { expect, test } from 'vitest';
import { z } from 'zod';
import { createAgentMachine } from '../index.js';
import { toXStateMachine, toXStateVisualization } from './index.js';

test('exports a serializable XState config for visualization', () => {
  const machine = createAgentMachine({
    id: 'xstate-export',
    schemas: {
      events: {
        submit: z.object({
          type: z.literal('submit'),
          count: z.number(),
        }),
      },
    },
    context: () => ({ total: 0 }),
    initial: 'idle',
    states: {
      idle: {
        on: {
          submit: ({ event }) => {
            if (event.count > 0) {
              return {
                target: 'working',
                context: { total: event.count },
                input: { index: event.count },
              };
            }

            return { target: 'done' };
          },
        },
      },
      working: {
        schemas: { input: z.object({
          index: z.number(),
        }), output: z.object({
          ok: z.boolean(),
        }) },
        invoke: async () => ({ ok: true }),
        onDone: () => ({
          target: 'done',
        }),
      },
      done: {
        type: 'final',
      },
    },
  });

  expect(toXStateVisualization(machine)).toEqual({
    id: 'xstate-export',
    initial: 'idle',
    meta: {
      agent: {
        format: '@statelyai/agent/xstate-visualization',
        runnable: false,
        note: 'Generated for visualization. Runtime semantics remain in the agent machine.',
      },
    },
    states: {
      idle: {
        on: {
          submit: [
            {
              target: 'working',
              guard: { type: 'event.count > 0' },
              actions: ['assignContext', 'assignInput'],
              meta: {
                agent: {
                  event: 'submit',
                  updates: {
                    context: true,
                    input: true,
                  },
                },
              },
            },
            {
              target: 'done',
              guard: { type: '!(event.count > 0)' },
              meta: {
                agent: {
                  event: 'submit',
                },
              },
            },
          ],
        },
      },
      working: {
        invoke: {
          id: 'invoke.working',
          src: 'invoke.working',
          onDone: {
            target: 'done',
            meta: {
              agent: {
                event: 'done.invoke.working',
              },
            },
          },
        },
        meta: {
          agent: {
            invoke: true,
          },
        },
      },
      done: {
        type: 'final',
      },
    },
  });
  expect(toXStateMachine(machine)).toEqual(toXStateVisualization(machine));
});

test('exports always transitions for visualization', () => {
  const machine = createAgentMachine({
    id: 'xstate-always',
    context: () => ({}),
    initial: 'checking',
    states: {
      checking: {
        always: ({ messages }) => ({
          target: 'done',
          messages: messages.concat({ role: 'assistant', content: 'ok' }),
        }),
      },
      done: {
        type: 'final',
      },
    },
  });

  expect(toXStateVisualization(machine).states.checking).toEqual({
    always: {
      target: 'done',
      actions: ['assignMessages'],
      meta: {
        agent: {
          event: '',
          updates: {
            messages: true,
          },
        },
      },
    },
  });
});
