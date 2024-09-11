import { openai } from '@ai-sdk/openai';
import { createAgent, fromDecision } from '../src';
import { assign, createActor, createMachine, fromPromise } from 'xstate';
import { z } from 'zod';
import { fromTerminal } from './helpers/helpers';

const agent = createAgent({
  model: openai('gpt-4o-mini'),
  events: {
    getTime: z.object({}).describe('Get the current time'),
    other: z.object({}).describe('Do something else'),
  },
});

const machine = createMachine({
  initial: 'start',
  context: {
    question: null,
  },
  states: {
    start: {
      invoke: {
        src: fromTerminal,
        input: 'What do you want to do?',
        onDone: {
          actions: assign({
            question: (x) => x.event.output,
          }),
          target: 'deciding',
        },
      },
    },
    deciding: {
      invoke: {
        src: fromDecision(agent),
        input: {
          goal: 'Satisfy the user question',
          context: true,
        },
      },
      on: {
        getTime: 'gettingTime',
        other: 'other',
      },
    },
    gettingTime: {
      invoke: {
        src: fromPromise(async () => {
          console.log('Time:', new Date().toLocaleTimeString());
        }),
        onDone: 'start',
      },
    },
    other: {
      entry: () => console.log('Nothing to do!'),
      type: 'final',
    },
  },
});

createActor(machine).start();
