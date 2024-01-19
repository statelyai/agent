import OpenAI from 'openai';
import {
  assign,
  createActor,
  fromCallback,
  fromPromise,
  log,
  raise,
  setup,
} from 'xstate';
import { createAgent } from '../src';
import { loadingAnimation } from './helpers/loader';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const agent = createAgent(openai, {
  model: 'gpt-3.5-turbo-1106',
  context: {
    topic: { type: 'string' },
    jokes: {
      type: 'array',
      items: {
        type: 'string',
      },
      desire: { type: ['string', 'null'] },
      lastRating: { type: ['string', 'null'] },
    },
  },
  events: {},
});

const getJokeCompletion = agent.fromChatCompletion(
  (topic: string) => `Tell me a joke about ${topic}.`
);

const rateJoke = agent.fromChatCompletion(
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

const decide = agent.fromEventChoice(
  (lastRating: string) =>
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
  types: {
    context: {} as {
      topic: string;
      jokes: string[];
      desire: string | null;
      lastRating: string | null;
    },
    input: {} as { topic: string },
  },
  actors: {
    getJokeCompletion,
    getTopic,
    rateJoke,
    decide,
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
          src: 'getJokeCompletion',
          input: ({ context }) => context.topic,
          onDone: {
            actions: [
              assign({
                jokes: ({ context, event }) =>
                  context.jokes.concat(
                    event.output.choices[0]!.message.content!
                  ),
              }),
              log((x) => x.context.jokes.at(-1)),
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
              assign({
                lastRating: ({ event }) =>
                  event.output.choices[0]!.message.content!,
              }),
              log(({ context }) => context.lastRating),
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
          actions: [
            log(({ event }) => event),
            raise(({ event }) => event.output![0]!),
          ],
        },
      },
      on: {
        askForTopic: {
          target: 'waitingForTopic',
          description:
            'Ask for a new topic, because the last joke rated 6 or lower',
        },
        endJokes: {
          target: 'end',
          description: 'End the jokes, since the last joke rated 7 or higher',
        },
      },
    },
    end: {
      type: 'final',
    },
  },
});

const actor = createActor(jokeMachine);
actor.start();
actor.subscribe((state) => {
  if (state.matches('end')) {
    process.exit();
  }
});
