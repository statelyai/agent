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
  /** @xstate-layout N4IgpgJg5mDOIC5QCsD2BrMA6A7gQwEsAXAgOygDFUAnAFVQAcCBjAYglVOzIDcNs0mXIRLkqdRiwS9UzPCU4BtAAwBdFasSgGqWMQKctIAB6IArAEZlWABzKALADYbAdjMAaEAE9EAJgCcvlhmAL4hnoLYRGAANjFkUABS-Oyc3KR8QpFY0XEJyZjSGbLyBqQaGkY6egqkRqYI9i4uwQDM-sqOvh7eiC4WNsFhEfxY1PJgBWCpXFgyWaPj0VNFfHK1FWpVuvqGSCbmVsE2vsqtFt2ePggXyoOh4SDZEGDMBC+seLDo4vRMzJV9tVdnV9g1HMorohzhYho9nq93tMwKQIFNYIDtDtavVEPZOlgLI5Ai47q1yRSoTdnC0HiMhC83h8OLN5gJRoykasShs1JiQMCcWDEET-MF7PZfKSbBSKRYqUTWo44Y9SKgXvB9pFtjUyriEABaew2KkGlw2YZPUb4fRiGh-Fg6kH6iz+VpYXw2SxmLo9a4dS3ZXLxchTJ1C0ANez+ZUWfquP14sz2QOLCZhoHYvXChBmO5YVp3MxutxU-wS1MMxEvcPZyMit0er0WH2XXo3eytFPw0YoiC1vb13Pk2z+Mwy2WyhU2LphMJAA */
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
        src: "getTopic",
        onDone: {
          actions: "inline:joke.waitingForTopic#done.invoke.joke.waitingForTopic:invocation[0][-1]#transition[0]",
          target: 'tellingJoke',
        },
      },
    },
    tellingJoke: {
      invoke: [
        {
          src: "getJokeCompletion",
          input: ({ context }) => context.topic,
          onDone: {
            actions: [
              "inline:joke.tellingJoke#done.invoke.joke.tellingJoke:invocation[0][-1]#transition[0]",
              "inline:joke.tellingJoke#done.invoke.joke.tellingJoke:invocation[0][-1]#transition[1]",
            ],
            target: 'rateJoke',
          },
        },
        {
          src: "loader",
          input: getRandomFunnyPhrase,
        },
      ],
    },
    rateJoke: {
      invoke: [
        {
          src: "rateJoke",
          input: ({ context }) => context.jokes[context.jokes.length - 1]!,
          onDone: {
            actions: [
              "inline:joke.rateJoke#done.invoke.joke.rateJoke:invocation[0][-1]#transition[0]",
              "inline:joke.rateJoke#done.invoke.joke.rateJoke:invocation[0][-1]#transition[1]",
            ],
            target: 'decide',
          },
        },
        {
          src: "loader",
          input: getRandomRatingPhrase,
        },
      ],
    },
    decide: {
      invoke: {
        src: "decide",
        input: ({ context }) => context.lastRating!,
        onDone: {
          actions: [
            "inline:joke.decide#done.invoke.joke.decide:invocation[0][-1]#transition[0]",
            "inline:joke.decide#done.invoke.joke.decide:invocation[0][-1]#transition[1]",
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
