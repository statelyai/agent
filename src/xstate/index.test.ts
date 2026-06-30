import { expect, test } from 'vitest';
import { setup, types } from 'xstate';
import { toXStateMachine, toXStateVisualization } from './index.js';

test('returns the serializable XState config for XState setup machines', () => {
  const agent = setup({
    schemas: {
      context: types<{}>(),
    },
  });
  const machine = agent.createMachine({
    id: 'xstate-export',
    context: {},
    initial: 'idle',
    states: {
      idle: { on: { NEXT: { target: 'done' } } },
      done: { type: 'final' },
    },
  });

  expect(toXStateVisualization(machine)).toEqual(machine.config);
  expect(toXStateMachine(machine)).toEqual(machine.config);
});
