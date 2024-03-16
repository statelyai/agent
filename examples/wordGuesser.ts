import { assign, log, setup } from 'xstate';
import { getFromTerminal } from './helpers/helpers';
import { createAgent, createOpenAIAdapter, defineEvents } from '../src';
import OpenAI from 'openai';
import { z } from 'zod';

const openAI = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const adapter = createOpenAIAdapter(openAI, {
  model: 'gpt-4-1106-preview',
});

const events = defineEvents({
  guessLetter: z.object({
    letter: z.string().min(1).max(1).describe('The letter guessed'),
  }),

  guessWord: z.object({
    word: z.string().describe('The word guessed'),
  }),
});

const context = {
  word: null as string | null,
  guessedWord: null as string | null,
  letters: [] as string[],
};

const wordGuesserMachine = setup({
  types: {
    context: {} as typeof context,
    events: events.type,
  },
  actors: {
    getFromTerminal,
    guesser: adapter.fromEvent(
      (input: typeof context) => `
You are trying to guess the word. The word has ${
        input.word!.length
      } letters. You have guessed the following letters so far: ${input.letters.join(
        ', '
      )}. These letters matched: ${input
        .word!.split('')
        .map((letter) =>
          input.letters.includes(letter.toUpperCase())
            ? letter.toUpperCase()
            : '_'
        )
        .join('')}
Please make your next guess - type a letter or the full word. You can only make 10 total guesses.
    `
    ),
  },
  schemas: {
    events: events.schemas,
  },
}).createMachine({
  initial: 'providingWord',
  context,
  states: {
    providingWord: {
      invoke: {
        src: 'getFromTerminal',
        input: 'Enter a word',
        onDone: {
          actions: assign({
            word: ({ event }) => event.output,
          }),
          target: 'guessing',
        },
      },
    },
    guessing: {
      always: {
        guard: ({ context }) => context.letters.length > 10,
        target: 'finalGuess',
      },
      invoke: {
        src: 'guesser',
        input: ({ context }) => context,
      },
      on: {
        guessLetter: {
          actions: assign({
            letters: ({ context, event }) => {
              return [...context.letters, event.letter.toUpperCase()];
            },
          }),
          target: 'guessing',
          reenter: true,
        },
        guessWord: {
          actions: assign({
            guessedWord: ({ event }) => event.word,
          }),
          target: 'gameOver',
        },
      },
    },
    finalGuess: {
      invoke: {
        src: 'guesser',
        input: ({ context }) => context,
      },
      on: {
        guessWord: {
          actions: assign({
            guessedWord: ({ event }) => event.word,
          }),
          target: 'gameOver',
        },
      },
    },
    gameOver: {
      entry: log(({ context }) => {
        if (
          context.guessedWord?.toUpperCase() === context.word?.toUpperCase()
        ) {
          return 'You won!';
        } else {
          return 'You lost! The word was ' + context.word;
        }
      }),
    },
  },
  exit: () => process.exit(),
});

const actor = createAgent(wordGuesserMachine, {
  inspect: (ev) => {
    if (ev.type === '@xstate.event') {
      console.log(ev.event);
    }
  },
});

actor.subscribe((s) => {
  console.log(s.value);
  console.log(s.context);
});

actor.start();
