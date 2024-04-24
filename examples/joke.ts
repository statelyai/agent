import OpenAI from 'openai';
import {
  assign,
  createActor,
  fromCallback,
  fromPromise,
  log,
  setup,
} from 'xstate';
import { createAgent, createOpenAIAdapter, defineEvents } from '../src';
import { loadingAnimation } from './helpers/loader';
import { z } from 'zod';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const events = defineEvents({
  askForTopic: z.object({
    topic: z.string().describe('The topic for the joke'),
  }),
  'agent.tellJoke': z.object({
    joke: z.string().describe('The joke text'),
  }),
  'agent.endJokes': z.object({}).describe('End the jokes'),

  'agent.rateJoke': z.object({
    rating: z.number().min(1).max(10),
    explanation: z.string(),
  }),
});

const adapter = createOpenAIAdapter(openai, {
  model: 'gpt-3.5-turbo-1106',
});

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

const agent = createAgent(openai, {
  model: 'gpt-3.5-turbo-1106',
});

const jokeMachine = setup({
  schemas: {
    events: events.schemas,
  },
  types: {
    context: {} as {
      topic: string;
      jokes: string[];
      desire: string | null;
      lastRating: number | null;
      loader: string | null;
    },
    events: events.types,
  },
  actors: {
    getTopic,
    agent,
    loader,
  },
}).createMachine({
  id: 'joke',
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
          src: 'agent',
          input: ({ context }) => ({
            goal: `Tell me a joke about ${context.topic}`,
          }),
        },
        {
          src: 'loader',
          input: getRandomFunnyPhrase,
        },
      ],
      on: {
        'agent.tellJoke': {
          actions: [
            assign({
              jokes: ({ context, event }) => [...context.jokes, event.joke],
            }),
            log(({ event }) => event.joke),
          ],
          target: 'rateJoke',
        },
      },
    },
    rateJoke: {
      invoke: [
        {
          src: 'agent',
          input: ({ context }) => ({
            goal: `Rate this joke on a scale of 1 to 10: ${
              context.jokes[context.jokes.length - 1]
            }`,
          }),
        },
        {
          src: 'loader',
          input: getRandomRatingPhrase,
        },
      ],
      on: {
        'agent.rateJoke': {
          actions: [
            assign({
              lastRating: ({ event }) => event.rating,
            }),
            log(({ event }) => event.explanation),
          ],
          target: 'decide',
        },
      },
    },
    decide: {
      invoke: {
        src: 'agent',
        input: ({ context }) => ({
          goal: `Choose what to do next, given the previous rating of the joke: ${context.lastRating}`,
        }),
      },
      on: {
        askForTopic: {
          target: 'waitingForTopic',
          actions: log("That joke wasn't good enough. Let's try again."),
          description:
            'Ask for a new topic, because the last joke rated 6 or lower',
        },
        'agent.endJokes': {
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

const actor = createActor(jokeMachine);

actor.start();
