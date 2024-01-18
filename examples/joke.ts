import OpenAI from 'openai';
import { assign, createActor, fromPromise, log, raise, setup } from 'xstate';
import { createAgent } from '../src';
import {
  getRandomFunnyPhrase,
  getRandomRatingPhrase,
} from '../src/helpers/jokeHelper';
import { loadingAnimation } from '../src/helpers/loader';

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

const promptTemplate = (topic: string) => `Tell me a joke about ${topic}.`;

const getJokeCompletion = agent.fromChatCompletion(promptTemplate);

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

const jokeMachine = setup({
  types: {
    context: {} as {
      topic: string;
      jokes: string[];
      desire: string | null;
      lastRating: string | null;
      loader: NodeJS.Timeout | null;
    },
    input: {} as { topic: string },
  },
  actors: {
    getJokeCompletion,
    getTopic,
    rateJoke,
    decide,
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
      entry: assign({ loader: () => loadingAnimation(getRandomFunnyPhrase()) }),
      invoke: {
        src: 'getJokeCompletion',
        input: ({ context }) => context.topic,
        onDone: {
          actions: [
            ({ context }) => {
              if (!context.loader) return;
              clearInterval(context.loader);
              console.log();
            },
            assign({
              jokes: ({ context, event }) =>
                context.jokes.concat(event.output.choices[0]!.message.content!),
            }),
            log((x) => x.context.jokes.at(-1)),
          ],
          target: 'rateJoke',
        },
      },
    },
    rateJoke: {
      entry: assign({
        loader: () => loadingAnimation(getRandomRatingPhrase()),
      }),
      invoke: {
        src: 'rateJoke',
        input: ({ context }) => context.jokes[context.jokes.length - 1]!,
        onDone: {
          actions: [
            ({ context }) => {
              if (!context.loader) return;
              clearInterval(context.loader);
              console.log();
            },
            assign({
              lastRating: ({ event }) =>
                event.output.choices[0]!.message.content!,
            }),
            log(({ context }) => context.lastRating),
          ],
          target: 'decide',
        },
      },
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
