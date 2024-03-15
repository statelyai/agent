import OpenAI from 'openai';
import { assign, fromCallback, fromPromise, log, setup } from 'xstate';
import { createAgent, createOpenAIAdapter, createSchemas } from '../src';
import { loadingAnimation } from './helpers/loader';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const schemas = createSchemas({
  context: {
    type: 'object',
    properties: {
      topic: { type: 'string' },
      jokes: {
        type: 'array',
        items: {
          type: 'string',
        },
      },
      desire: { type: ['string', 'null'] },
      lastRating: { type: ['number', 'null'] },
    },
    required: ['topic', 'jokes', 'desire', 'lastRating'],
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
    tellJoke: {
      type: 'object',
      properties: {
        joke: {
          type: 'string',
        },
      },
    },
    endJokes: {
      type: 'object',
      properties: {},
    },
    rateJoke: {
      type: 'object',
      properties: {
        rating: {
          type: 'number',
          minimum: 1,
          maximum: 10,
        },
        explanation: {
          type: 'string',
          description: 'An explanation for the rating',
        },
      },
    },
  },
});

const adapter = createOpenAIAdapter(openai, {
  model: 'gpt-3.5-turbo-1106',
});

const getJokeCompletion = adapter.fromEvent(
  (topic: string) => `Tell me a joke about ${topic}.`
);

const rateJoke = adapter.fromEvent(
  (joke: string) => `Rate this joke on a scale of 1 to 10: ${joke}`
);

const getTopic = fromPromise(async () => {
  const topic = await new Promise<string>((res) => {
    console.log('Give me a joke topic:');
    const listener = (data: Buffer) => {
      const result = data.toString().trim();
      process.stdin.off('data', listener);
      res(result);
    };
    process.stdin.on('data', listener);
  });

  return topic;
});

const decide = adapter.fromEvent(
  (lastRating: number) =>
    `Choose what to do next, given the previous rating of the joke: ${lastRating}`
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

const loader = fromCallback(({ input }: { input: string }) => {
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
    getTopic,
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
      invoke: {
        src: 'getTopic',
        onDone: {
          actions: assign({
            topic: ({ event }) => event.output,
          }),
          target: 'tellingJoke',
        },
      },
    },
    tellingJoke: {
      invoke: [
        {
          src: 'getJokeCompletion',
          input: ({ context }) => context.topic,
        },
        {
          src: 'loader',
          input: getRandomFunnyPhrase,
        },
      ],
      on: {
        tellJoke: {
          actions: assign({
            jokes: ({ context, event }) => [...context.jokes, event.joke],
          }),
          target: 'rateJoke',
        },
      },
    },
    rateJoke: {
      invoke: [
        {
          src: 'rateJoke',
          input: ({ context }) => context.jokes[context.jokes.length - 1]!,
        },
        {
          src: 'loader',
          input: getRandomRatingPhrase,
        },
      ],
      on: {
        rateJoke: {
          actions: assign({
            lastRating: ({ event }) => event.rating,
          }),
          target: 'decide',
        },
      },
    },
    decide: {
      invoke: {
        src: 'decide',
        input: ({ context }) => context.lastRating!,
      },
      on: {
        askForTopic: {
          target: 'waitingForTopic',
          actions: log("That joke wasn't good enough. Let's try again."),
          description:
            'Ask for a new topic, because the last joke rated 6 or lower',
        },
        endJokes: {
          target: 'end',
          actions: log('That joke was good enough. Goodbye!'),
          description: 'End the jokes, since the last joke rated 7 or higher',
        },
      },
    },
    end: {
      type: 'final',
    },
  },
  exit: () => {
    process.exit();
  },
});

const agent = createAgent(jokeMachine, {
  inspect: (ev) => {
    if (ev.type === '@xstate.event') {
      console.log(ev.event);
    }
  },
});
agent.start();
