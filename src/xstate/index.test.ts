import { expect, test } from 'vitest';
import { setup } from 'xstate';
import { toXStateMachine, toXStateVisualization } from './index.js';

test('returns the serializable XState config for XState setup machines', () => {
  const agent = setup({
    types: {} as { context: {} },
  });
  const machine = agent.createMachine({
    id: 'xstate-export',
    context: {},
    initial: 'idle',
    states: {
      idle: { on: { NEXT: 'done' } },
      done: { type: 'final' },
    },
  });

  expect(toXStateVisualization(machine)).toEqual(machine.config);
  expect(toXStateMachine(machine)).toEqual(machine.config);
});
