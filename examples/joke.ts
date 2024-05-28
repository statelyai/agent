import { assign, createActor, fromCallback, log, setup } from 'xstate';
import { createAgent } from '../src';
import { loadingAnimation } from './helpers/loader';
import { z } from 'zod';
import { openai } from '@ai-sdk/openai';
import { getFromTerminal } from './helpers/helpers';

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

const agent = createAgent({
  name: 'joke-teller',
  model: openai('gpt-4-turbo'),
  events: {
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
    'agent.continue': z.object({}).describe('Continue'),
    'agent.markAsIrrelevant': z
      .object({
        explanation: z.string(),
      })
      .describe('Explains why the joke was irrelevant'),
    'agent.markAsRelevant': z.object({}).describe('The joke was relevant'),
  },
});

const jokeMachine = setup({
  types: {
    context: {} as {
      topic: string;
      jokes: string[];
      desire: string | null;
      lastRating: number | null;
      loader: string | null;
    },
    events: agent.eventTypes,
  },
  actors: {
    agent: agent.fromDecision(),
    loader,
    getFromTerminal,
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
        src: 'getFromTerminal',
        input: 'Give me a joke topic.',
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
            context: {
              topic: context.topic,
            },
            goal: `Tell me a joke about the topic. Do not make any joke that is not relevant to the topic.`,
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
            log((x) => x.event.joke),
          ],
          target: 'relevance',
        },
      },
    },
    relevance: {
      invoke: {
        src: 'agent',
        input: (x) => ({
          context: {
            topic: x.context.topic,
            lastJoke: x.context.jokes[x.context.jokes.length - 1],
          },
          goal: 'An irrelevant joke has no reference to the topic. If the last joke is completely irrelevant to the topic, ask for a new joke topic. Otherwise, continue.',
        }),
      },
      on: {
        'agent.markAsIrrelevant': {
          actions: log((x) => 'Irrelevant joke: ' + x.event.explanation),
          target: 'waitingForTopic',
          description: 'Continue',
        },
        'agent.markAsRelevant': {
          actions: log('Joke was relevant'),
          target: 'rateJoke',
        },
      },
    },
    rateJoke: {
      invoke: [
        {
          src: 'agent',
          input: ({ context }) => ({
            context: {
              jokes: context.jokes,
            },
            goal: `Rate the last joke on a scale of 1 to 10.`,
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
            log(
              ({ event }) => `Rating: ${event.rating}\n\n${event.explanation}`
            ),
          ],
          target: 'decide',
        },
      },
    },
    decide: {
      invoke: {
        src: 'agent',
        input: ({ context }) => ({
          context: {
            lastRating: context.lastRating,
          },
          goal: `Choose what to do next, given the previous rating of the joke.`,
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

agent.onMessage((msg) => {
  console.log(msg);
});

actor.start();
