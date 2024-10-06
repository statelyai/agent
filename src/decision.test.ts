import { test, expect } from 'vitest';
import { createAgent, fromDecision } from '.';
import { createActor, createMachine, waitFor } from 'xstate';
import { z } from 'zod';
import { LanguageModelV1CallOptions } from 'ai';
import { dummyResponseValues, MockLanguageModelV1 } from './mockModel';

const doGenerate = async (params: LanguageModelV1CallOptions) => {
  const keys =
    params.mode.type === 'regular' ? params.mode.tools?.map((t) => t.name) : [];

  return {
    ...dummyResponseValues,
    finishReason: 'tool-calls',
    toolCalls: [
      {
        toolCallType: 'function',
        toolCallId: 'call-1',
        toolName: keys![0],
        args: `{ "type": "${keys?.[0]}" }`,
      },
    ],
  } as any;
};

test('fromDecision() makes a decision', async () => {
  const model = new MockLanguageModelV1({
    doGenerate,
  });
  const agent = createAgent({
    name: 'test',
    model,
    events: {
      doFirst: z.object({}),
      doSecond: z.object({}),
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
  const model = new MockLanguageModelV1({
    doGenerate,
  });
  const agent = createAgent({
    name: 'test',
    model,
    events: {
      doFirst: z.object({}),
      doSecond: z.object({}),
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

test('interacts with an actor (late interaction)', async () => {
  const model = new MockLanguageModelV1({
    doGenerate,
  });
  const agent = createAgent({
    name: 'test',
    model,
    events: {
      doFirst: z.object({}),
      doSecond: z.object({}),
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

  actor.start();

  agent.interact(actor, () => ({
    goal: 'Some goal',
  }));

  await waitFor(actor, (s) => s.matches('third'));

  expect(actor.getSnapshot().value).toBe('third');
});
