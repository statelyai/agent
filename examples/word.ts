import { assign, createActor, log, setup } from 'xstate';
import { getFromTerminal } from './helpers/helpers';
import { createAgent } from '../src';
import { z } from 'zod';
import { openai } from '@ai-sdk/openai';

const context = {
  word: null as string | null,
  guessedWord: null as string | null,
  lettersGuessed: [] as string[],
};

const agent = createAgent({
  model: openai('gpt-4-1106-preview'),
  events: {
    'agent.guessLetter': z.object({
      letter: z.string().min(1).max(1).describe('The letter guessed'),
    }),

    'agent.guessWord': z.object({
      word: z.string().describe('The word guessed'),
    }),

    'agent.respond': z.object({
      response: z
        .string()
        .describe(
          'The response from the agent, detailing why the guess was correct or incorrect based on the letters guessed.'
        ),
    }),
  },
});

const wordGuesserMachine = setup({
  types: {
    context: {} as typeof context,
    events: agent.eventTypes,
  },
  actors: {
    agent: agent.fromDecision(),
    getFromTerminal,
  },
}).createMachine({
  initial: 'providingWord',
  context,
  states: {
    providingWord: {
      entry: assign(context),
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
        guard: ({ context }) => context.lettersGuessed.length > 10,
        target: 'finalGuess',
      },
      invoke: {
        src: 'agent',
        input: ({ context }) => ({
          context: {
            lettersGuessed: context.lettersGuessed,
          },
          goal: `
          You are trying to guess the word. The word has ${
            context.word!.length
          } letters. These letters matched: ${context
            .word!.split('')
            .map((letter) =>
              context.lettersGuessed.includes(letter.toUpperCase())
                ? letter.toUpperCase()
                : '_'
            )
            .join('')}
          Please make your next guess - guess a letter or, if you think you know the word, guess the full word. You can only make 10 total guesses. If you are confident you know the word, it is better to guess the word.
              `,
        }),
      },
      on: {
        'agent.guessLetter': {
          actions: [
            assign({
              lettersGuessed: ({ context, event }) => {
                return [...context.lettersGuessed, event.letter.toUpperCase()];
              },
            }),
            log(({ event }) => event),
          ],
          target: 'guessing',
          reenter: true,
        },
        'agent.guessWord': {
          actions: [
            assign({
              guessedWord: ({ event }) => event.word,
            }),
            log(({ event }) => event),
          ],
          target: 'gameOver',
        },
      },
    },
    finalGuess: {
      invoke: {
        src: 'agent',
        input: ({ context }) => ({
          context: {
            lettersGuessed: context.lettersGuessed,
          },
          goal: `You have used all 10 guesses. These letters matched: ${context
            .word!.split('')
            .map((letter) =>
              context.lettersGuessed.includes(letter.toUpperCase())
                ? letter.toUpperCase()
                : '_'
            )
            .join('')}. Guess the word.`,
        }),
      },
      on: {
        'agent.guessWord': {
          actions: [
            assign({
              guessedWord: ({ event }) => event.word,
            }),
            log(({ event }) => event),
          ],
          target: 'gameOver',
        },
      },
    },
    gameOver: {
      invoke: {
        src: 'agent',
        input: ({ context }) => ({
          context,
          goal: `Why do you think you won or lost?`,
        }),
      },
      entry: log(({ context }) => {
        if (
          context.guessedWord?.toUpperCase() === context.word?.toUpperCase()
        ) {
          return 'You won!';
        } else {
          return 'You lost! The word was ' + context.word;
        }
      }),
      on: {
        'agent.respond': {
          actions: log(({ event }) => event.response),
          target: 'providingWord',
        },
      },
    },
  },
  exit: () => process.exit(),
});

const game = createActor(wordGuesserMachine);

game.start();
