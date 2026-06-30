import { setup, types, type AnyStateMachine } from 'xstate';

const agent = setup({
  schemas: {
    context: types<{}>(),
    events: {
      submit: types<{ ok: boolean }>(),
      go: types<{}>(),
    },
  },
});

export const namedMachine = createFixtureMachine('named-converter-machine');

export const machine = createFixtureMachine('default-converter-machine');

export const warningMachine = agent.createMachine({
  id: 'warning-converter-machine',
  context: {},
  initial: 'idle',
  states: {
    idle: {
      on: {
        go: { target: 'done' },
      },
    },
    done: { type: 'final' },
  },
});

export default machine;

export function createFixtureMachine(
  id = 'factory-converter-machine'
): AnyStateMachine {
  return agent.createMachine({
    id,
    context: {},
    initial: 'idle',
    states: {
      idle: {
        on: {
          submit: ({ event }) =>
            event.ok ? { target: 'done' } : { target: 'rejected' },
        },
      },
      rejected: { type: 'final' },
      done: { type: 'final' },
    },
  });
}
