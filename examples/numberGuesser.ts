import OpenAI from 'openai';
import { createAgent, createOpenAIAdapter, defineEvents } from '../src';
import { assign, setup } from 'xstate';
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const adapter = createOpenAIAdapter(openai, {
  model: 'gpt-3.5-turbo-1106',
});

const guessLogic = adapter.fromEvent(
  ({
    previousGuesses,
    lastResult,
  }: {
    previousGuesses: number[];
    lastResult: string;
  }) => `
  Guess the number between 1 and 10. The previous guesses were ${
    previousGuesses.length ? previousGuesses.join(', ') : 'not made yet'
  } and the last result was ${lastResult}.
`
);

const eventSchemas = defineEvents({
  guess: {
    properties: {
      number: {
        // integer
        type: 'number',
        minimum: 1,
        maximum: 10,
      },
    },
    required: ['number'],
  },
});

const machine = setup({
  types: {
    context: {} as {
      previousGuesses: number[];
      answer: number;
    },
    input: {} as { answer: number },
    events: eventSchemas.types,
  },
  schemas: eventSchemas,
  actors: {
    guessLogic,
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
        src: 'guessLogic',
        input: ({ context }) => ({
          previousGuesses: context.previousGuesses,
          lastResult:
            context.previousGuesses.length === 0
              ? 'not given yet'
              : context.previousGuesses.at(-1)! - context.answer > 0
              ? 'too high'
              : 'too low',
        }),
      },
      on: {
        guess: {
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
      type: 'final',
    },
  },
});

const agent = createAgent(machine, {
  input: { answer: 4 },
  inspect: (ev) => {
    if (ev.type === '@xstate.event') {
      console.log(ev.event);
    }
  },
});

agent.start();
