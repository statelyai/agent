import OpenAI from 'openai';
import { assign, fromPromise, createActor, waitFor, setup } from 'xstate';
import { fromEventChoice } from '../src/index';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function start() {
  const promptTemplate = (topic: string) => `Tell me a joke about ${topic}.`;

  const getJokeCompletion = fromPromise(
    async ({ input }: { input: { topic: string } }) => {
      const res = await openai.chat.completions.create({
        messages: [
          {
            role: 'user',
            content: promptTemplate(input.topic),
          },
        ],
        model: 'gpt-3.5-turbo',
        n: 1,
      });

      return res.choices[0]?.message.content;
    }
  );

  const rateJoke = fromPromise(
    async ({ input }: { input: { joke: string } }) => {
      const res = await openai.chat.completions.create({
        messages: [
          {
            role: 'user',
            content: `Rate this joke on a scale of 1 to 10: ${input.joke}`,
          },
        ],
        model: 'gpt-3.5-turbo',
        n: 1,
      });

      return res.choices[0]?.message.content;
    }
  );

  const getTopic = fromPromise(async () => {
    const topic = await new Promise<string>((res) => {
      console.log('Give me a topic: \n\n');
      process.stdin.on('data', (data) => {
        const eventType = data.toString().trim();
        res(eventType);
      });
    });

    return topic;
  });

  const chain = setup({
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
      decide: fromEventChoice(openai, (desire: string) => ({
        model: 'gpt-4-1106-preview',
        messages: [
          {
            role: 'user',
            content: `Execute the function that best satisfies this desire:

${desire}
`,
          },
        ],
      })),
    },
  }).createMachine({
    context: ({ input }) => ({
      topic: input.topic,
      jokes: [],
      desire: null,
      lastRating: null,
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
        invoke: {
          src: 'getJokeCompletion',
          input: ({ context }) => ({ topic: context.topic }),
          onDone: {
            actions: assign({
              jokes: ({ context, event }) =>
                context.jokes.concat(event.output as string),
            }),
            target: 'rateJoke',
          },
        },
      },
      rateJoke: {
        invoke: {
          src: 'rateJoke',
          input: ({ context }) => ({
            joke: context.jokes[context.jokes.length - 1]!,
          }),
          onDone: {
            actions: assign({
              lastRating: ({ event }) => event.output as string,
            }),
            target: 'joked',
          },
        },
      },
      joked: {
        invoke: {
          src: 'getTopic',
          onDone: {
            actions: assign({
              desire: ({ event }) => event.output,
            }),
            target: 'decide',
          },
        },
      },
      decide: {
        invoke: {
          src: 'decide',
          input: ({ context }) => context.desire!,
        },
        on: {
          askForTopic: {
            target: 'waitingForTopic',
            description:
              'Ask for a new topic, because the last joke was almost perfect',
          },
          endJokes: {
            target: 'end',
            description: 'End the jokes, since the last joke was not too good',
          },
        },
      },
      end: {},
    },
  });

  const actor = createActor(chain, {
    input: {
      topic: 'donuts',
    },
  });

  actor.subscribe((st) => {
    console.log('State: ', st.value);

    if (st.context.jokes) {
      console.log('Joke: ', st.context.jokes[st.context.jokes.length - 1]);
    }
  });

  actor.start();

  await waitFor(actor, (snap) => snap.status === 'done', {
    timeout: Infinity,
  });
}

start();
