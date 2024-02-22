import * as dotenv from 'dotenv';

import OpenAI from 'openai';
import { assign, enqueueActions, fromCallback, setup } from 'xstate';
import {
  createAgent,
  createOpenAIAdapter,
  createSchemas,
} from '@statelyai/agent';
import { loadingAnimation } from './helpers/loader.ts';

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const schemas = createSchemas({
  context: {
    topic: { type: 'string' },
    jokes: {
      type: 'array',
      items: {
        type: 'string',
      },
    },
    desire: { type: ['string', 'null'] },
    lastRating: { type: ['string', 'null'] },
    // TODO: replace with this when new `@statelyai/agent` gets released with the new context schame types
    //
    // type: 'object',
    // properties: {
    //   topic: { type: 'string' },
    //   jokes: {
    //     type: 'array',
    //     items: {
    //       type: 'string',
    //     },
    //   },
    //   desire: { type: ['string', 'null'] },
    //   lastRating: { type: ['string', 'null'] },
    // },
    // required: ['topic', 'jokes', 'desire', 'lastRating'],
  },
  events: {
    askForTopic: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
        },
      },
    },
    setTopic: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
        },
      },
    },
    endJokes: {
      type: 'object',
      properties: {},
    },
  },
  // TODO: after updating to the new `@statelyai/agent` version this assertion shouldn't be needed
} as const);
const adapter = createOpenAIAdapter(openai, {
  model: 'gpt-3.5-turbo-1106',
});

const getJokeCompletion = adapter.fromChat(
  (topic: string) => `Tell me a joke about ${topic}.`,
);

const rateJoke = adapter.fromChat(
  (joke: string) => `Rate this joke on a scale of 1 to 10: ${joke}`,
);

const decide = adapter.fromEvent(
  (lastRating: string) =>
    `Choose what to do next, given the previous rating of the joke: ${lastRating}`,
);
export function getRandomFunnyPhrase() {
  const funnyPhrases = [
    'Concocting chuckles...',
    'Brewing belly laughs...',
    'Fabricating funnies...',
    'Assembling amusement...',
    'Molding merriment...',
    'Whipping up wisecracks...',
    'Generating guffaws...',
    'Inventing hilarity...',
    'Cultivating chortles...',
    'Hatching howlers...',
  ];
  return funnyPhrases[Math.floor(Math.random() * funnyPhrases.length)]!;
}

export function getRandomRatingPhrase() {
  const ratingPhrases = [
    'Assessing amusement...',
    'Evaluating hilarity...',
    'Ranking chuckles...',
    'Classifying cackles...',
    'Scoring snickers...',
    'Rating roars...',
    'Judging jollity...',
    'Measuring merriment...',
    'Rating rib-ticklers...',
  ];
  return ratingPhrases[Math.floor(Math.random() * ratingPhrases.length)]!;
}

export function createJokeMachine({ log }: { log: (message: string) => void }) {
  const loader = fromCallback(({ input }: { input: string }) => {
    log(input);
    const anim = loadingAnimation(input);

    return () => {
      anim.stop();
    };
  });

  const jokeMachine = setup({
    schemas,
    types: schemas.types,
    actors: {
      getJokeCompletion,
      rateJoke,
      decide,
      loader,
    },
  }).createMachine({
    context: () => ({
      topic: '',
      jokes: [],
      desire: null,
      lastRating: null,
      loader: null,
    }),
    initial: 'waitingForTopic',
    states: {
      waitingForTopic: {
        on: {
          setTopic: {
            actions: [
              assign({
                topic: ({ event }) => event.topic,
              }),
              ({ event }) => log(`--- Topic event set to: ${event.topic} ---`),
            ],

            target: 'tellingJoke',
          },
        },
      },
      tellingJoke: {
        invoke: [
          {
            src: 'getJokeCompletion',
            input: ({ context }) => context.topic,
            onDone: {
              actions: [
                assign({
                  jokes: ({ context, event }) =>
                    context.jokes.concat(
                      event.output.choices[0]!.message.content!,
                    ),
                }),
                ({ context }) => {
                  const jokeStr = context.jokes.at(-1);
                  if (jokeStr) {
                    log(jokeStr);
                  }
                },
              ],
              target: 'rateJoke',
            },
          },
          {
            src: 'loader',
            input: getRandomFunnyPhrase,
          },
        ],
      },
      rateJoke: {
        invoke: [
          {
            src: 'rateJoke',
            input: ({ context }) => context.jokes[context.jokes.length - 1]!,
            onDone: {
              actions: [
                enqueueActions(({ enqueue, event }) => {
                  const lastRating = event.output.choices[0]!.message.content!;
                  enqueue.assign({
                    lastRating,
                  });
                  log(lastRating);
                }),
              ],
              target: 'decide',
            },
          },
          {
            src: 'loader',
            input: getRandomRatingPhrase,
          },
        ],
      },
      decide: {
        invoke: {
          src: 'decide',
          input: ({ context }) => context.lastRating!,
          onDone: {
            actions: ({ event }) => console.log('unknown:', event), //log(event.message),
          },
        },
        on: {
          askForTopic: {
            target: 'waitingForTopic',
            actions: [
              () => log("That joke wasn't good enough. Let's try again."),
            ],
            description:
              'Ask for a new topic, because the last joke rated 6 or lower',
          },
          endJokes: {
            target: 'end',
            actions: [() => log('That joke was good enough. Goodbye!')],
            description: 'End the jokes, since the last joke rated 7 or higher',
          },
        },
      },
      end: {
        type: 'final',
      },
    },
    exit: () => {
      log('exit');
    },
  });

  return createAgent(jokeMachine);
}
