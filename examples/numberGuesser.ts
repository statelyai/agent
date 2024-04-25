import OpenAI from 'openai';
import { createAgent, createOpenAIAdapter, defineEvents } from '../src';
import { assign, createActor, log, setup } from 'xstate';
import { z } from 'zod';
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const agent = createAgent(openai, {
  model: 'gpt-3.5-turbo-1106',
});

const events = defineEvents({
  'agent.guess': z.object({
    number: z.number().min(1).max(10).describe('The number guessed'),
  }),
});

const machine = setup({
  types: {
    context: {} as {
      previousGuesses: number[];
      answer: number;
    },
    input: {} as { answer: number },
    events: events.types,
  },
  schemas: {
    events: events.schemas,
  },
  actors: {
    agent,
  },
}).createMachine({
  context: ({ input }) => ({
    answer: input.answer,
    previousGuesses: [],
  }),
  initial: 'guessing',
  states: {
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
              : context.previousGuesses.at(-1)! - context.answer > 0
              ? 'too high'
              : 'too low'
          }.
        `,
        }),
      },
      on: {
        'agent.guess': {
          actions: assign({
            previousGuesses: ({ context, event }) => [
              ...context.previousGuesses,
              event.number,
            ],
          }),
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
});

const actor = createActor(machine, {
  input: { answer: 4 },
  inspect: (ev) => {
    if (ev.type === '@xstate.event') {
      console.log(ev.event);
    }
  },
});

actor.start();
