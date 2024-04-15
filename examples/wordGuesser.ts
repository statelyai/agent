import { assign, createActor, log, setup } from 'xstate';
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
  'agent.guessLetter': z.object({
    letter: z.string().min(1).max(1).describe('The letter guessed'),
  }),

  'agent.guessWord': z.object({
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
    events: events.types,
  },
  actors: {
    getFromTerminal,
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
      // invoke: {
      //   src: 'guesser',
      //   input: ({ context }) => context,
      // },
      on: {
        'agent.guessLetter': {
          actions: assign({
            letters: ({ context, event }) => {
              return [...context.letters, event.letter.toUpperCase()];
            },
          }),
          target: 'guessing',
          reenter: true,
        },
        'agent.guessWord': {
          actions: assign({
            guessedWord: ({ event }) => event.word,
          }),
          target: 'gameOver',
        },
      },
    },
    finalGuess: {
      // invoke: {
      //   src: 'guesser',
      //   input: ({ context }) => context,
      // },
      on: {
        'agent.guessWord': {
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
      after: {
        1000: 'providingWord',
      },
    },
  },
  exit: () => process.exit(),
});

const game = createActor(wordGuesserMachine);

const agent = createAgent<typeof game>(
  openAI,
  (s) => {
    if (s.matches('guessing')) {
      return `
      You are trying to guess the word. The word has ${
        s.context.word!.length
      } letters. You have guessed the following letters so far: ${s.context.letters.join(
        ', '
      )}. These letters matched: ${s.context
        .word!.split('')
        .map((letter) =>
          s.context.letters.includes(letter.toUpperCase())
            ? letter.toUpperCase()
            : '_'
        )
        .join('')}
      Please make your next guess - guess a letter or, if you think you know the word, guess the full word. You can only make 10 total guesses.
          `;
    }

    if (s.matches('finalGuess')) {
      return `You have used all 10 guesses. You have guessed the following letters so far: ${s.context.letters.join(
        ', '
      )}. These letters matched: ${s.context
        .word!.split('')
        .map((letter) =>
          s.context.letters.includes(letter.toUpperCase())
            ? letter.toUpperCase()
            : '_'
        )
        .join('')}. Guess the word.`;
    }

    return [];
  },
  events.schemas as any
);

game.subscribe(() => {
  agent.act(game);
});

game.start();
