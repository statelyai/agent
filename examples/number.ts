import { createAgent } from '../src';
import { assign, createActor, log, setup } from 'xstate';
import { z } from 'zod';
import { openai } from '@ai-sdk/openai';
import { getFromTerminal } from './helpers/helpers';

const agent = createAgent({
  model: openai('gpt-3.5-turbo-1106'),
  events: {
    'agent.guess': z.object({
      number: z.number().min(1).max(10).describe('The number guessed'),
    }),
  },
});

const machine = setup({
  types: {
    context: {} as {
      previousGuesses: number[];
      answer: number | null;
    },
    events: agent.eventTypes,
  },
  actors: {
    agent: agent.fromDecision(),
    getFromTerminal,
  },
}).createMachine({
  context: {
    answer: null,
    previousGuesses: [],
  },
  initial: 'providing',
  states: {
    providing: {
      invoke: {
        src: 'getFromTerminal',
        input: 'Enter a number between 1 and 10',
        onDone: {
          actions: assign({
            answer: (x) => +x.event.output,
          }),
          target: 'guessing',
        },
      },
    },
    guessing: {
      always: {
        guard: ({ context }) =>
          context.answer === context.previousGuesses.at(-1),
        target: 'winner',
      },
      invoke: {
        src: 'agent',
        input: ({ context }) => ({
          goal: `
          Guess the number between 1 and 10. The previous guesses were ${
            context.previousGuesses.length
              ? context.previousGuesses.join(', ')
              : 'not made yet'
          } and the last result was ${
            context.previousGuesses.length === 0
              ? 'not given yet'
              : context.previousGuesses.at(-1)! - context.answer! > 0
              ? 'too high'
              : 'too low'
          }.
        `,
        }),
      },
      on: {
        'agent.guess': {
          actions: [
            assign({
              previousGuesses: ({ context, event }) => [
                ...context.previousGuesses,
                event.number,
              ],
            }),
            log((x) => x.event.number),
          ],
          target: 'guessing',
          reenter: true,
        },
      },
    },
    winner: {
      entry: log('You guessed the correct number!'),
      type: 'final',
    },
  },
  exit: () => {
    process.exit();
  },
});

const actor = createActor(machine, {
  input: { answer: 4 },
});

actor.start();
