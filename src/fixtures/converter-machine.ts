import { setup } from 'xstate';

const agent = setup({
  types: {} as {
    context: {};
    events:
      | { type: 'submit'; ok: boolean }
      | { type: 'go' };
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

export function createFixtureMachine(id = 'factory-converter-machine') {
  return agent.createMachine({
    id,
    context: {},
    initial: 'idle',
    states: {
      idle: {
        on: {
          submit: [
            { guard: ({ event }) => event.ok, target: 'done' },
            { target: 'rejected' },
          ],
        },
      },
      rejected: { type: 'final' },
      done: { type: 'final' },
    },
  });
}
