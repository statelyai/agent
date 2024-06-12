import { test, expect } from 'vitest';
import { createAgent, fromDecision, type AIAdapter } from './';
import { createActor, createMachine, waitFor } from 'xstate';
import { z } from 'zod';
import { GenerateTextResult } from 'ai';

test('fromDecision() makes a decision', async () => {
  const agent = createAgent({
    name: 'test',
    model: {} as any,
    events: {
      doFirst: z.object({}),
      doSecond: z.object({}),
    },
    adapter: {
      generateText: async (arg) => {
        const keys = Object.keys(arg.tools!);

        if (keys.length !== 1) {
          throw new Error('Expected only 1 choice');
        }

        return {
          toolResults: [
            {
              result: {
                type: keys[0],
              },
            },
          ],
        } as any as GenerateTextResult<any>;
      },
      streamText: {} as any,
    },
  });

  const machine = createMachine({
    initial: 'first',
    states: {
      first: {
        invoke: {
          src: fromDecision(agent),
        },
        on: {
          doFirst: 'second',
        },
      },
      second: {
        invoke: {
          src: fromDecision(agent),
        },
        on: {
          doSecond: 'third',
        },
      },
      third: {},
    },
  });

  const actor = createActor(machine);

  actor.start();

  await waitFor(actor, (s) => s.matches('third'));

  expect(actor.getSnapshot().value).toBe('third');
});

test('interacts with an actor', async () => {
  const agent = createAgent({
    name: 'test',
    model: {} as any,
    events: {
      doFirst: z.object({}),
      doSecond: z.object({}),
    },
    adapter: {
      generateText: async (arg) => {
        const keys = Object.keys(arg.tools!);

        console.log(keys);

        if (keys.length > 1) {
          throw new Error('Expected only 1 choice');
        }

        if (keys.length === 0) {
          return {
            toolResults: [],
          } as any as GenerateTextResult<any>;
        }

        return {
          toolResults: [
            {
              result: {
                type: keys[0],
              },
            },
          ],
        } as any as GenerateTextResult<any>;
      },
      streamText: {} as any,
    },
  });

  const machine = createMachine({
    initial: 'first',
    states: {
      first: {
        on: {
          doFirst: 'second',
        },
      },
      second: {
        on: {
          doSecond: 'third',
        },
      },
      third: {},
    },
  });

  const actor = createActor(machine);

  agent.interact(actor, () => ({
    goal: 'Some goal',
  }));

  actor.start();

  await waitFor(actor, (s) => s.matches('third'));

  expect(actor.getSnapshot().value).toBe('third');
});
