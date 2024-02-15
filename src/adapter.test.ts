import { test, expect } from 'vitest';
import { createOpenAIAdapter, createTool } from './adapters/openai';
import OpenAI from 'openai';
import { ContextFrom, assign, createActor, setup, toPromise } from 'xstate';
import { createSchemas } from './schemas';

test('fromTool - weather or illustration', async () => {
  const openAi = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  const adapter = createOpenAIAdapter(openAi, {
    model: 'gpt-3.5-turbo',
  });

  const toolChoice = adapter.fromTool(() => 'Create an image of a donut', {
    makeIllustration: {
      description: 'Make an illustration',
      run: async () => 'Illustration',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'The name of the illustration',
          },
        },
        required: ['name'],
      },
    },
    getWeather: {
      description: 'Get the weather for a location',
      run: async () => 'Weather',
      inputSchema: {
        type: 'object',
        properties: {
          location: {
            type: 'object',
            properties: {
              city: {
                type: 'string',
                description: 'The name of the city',
              },
              state: {
                type: 'string',
                description: 'The name of the state',
              },
            },
            required: ['city', 'state'],
          },
        },
        required: ['location'],
      },
    },
  });

  const actor = createActor(toolChoice);

  actor.start();

  const res = await toPromise(actor);

  expect(res?.result).toBe('Illustration');
});

test('fromTool - GitHub PR description inserter', async () => {
  const openAi = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  const adapter = createOpenAIAdapter(openAi, {
    model: 'gpt-3.5-turbo-16k-0613',
  });

  const toolChoice = adapter.fromTool(
    (input: string) =>
      `Create a GitHub PR description for the following: ${input}`,
    {
      fetchGitHubPR: {
        description: 'Fetch a GitHub PR',
        run: async (input: string) => {
          return {
            title: 'Title',
            body: input,
          };
        },
        inputSchema: {
          type: 'object',
          properties: {
            repo: {
              type: 'string',
              description: 'The name of the repo',
            },
            number: {
              type: 'number',
              description: 'The number of the PR',
            },
          },
          required: ['repo', 'number'],
        },
      },
      createPullRequestDescription: {
        description: 'Create a GitHub PR description',
        run: () => 'Description',
        inputSchema: {
          type: 'object',
          properties: {
            title: {
              type: 'string',
              description: 'The title of the PR',
            },
            body: {
              type: 'string',
              description: 'The body of the PR',
            },
          },
          required: ['title', 'body'],
        },
      },
    }
  );

  const actor = createActor(toolChoice, {
    input:
      // 'Get the details from this: https://github.com/microsoft/TypeScript/pull/47198',
      'Make a summary of this PR: (some code here)',
  });

  actor.start();

  const res = await toPromise(actor);

  expect(res?.tool).toEqual('createPullRequestDescription');
  expect(res?.result).toEqual('Description');
});

test('fromTool - joke creator or rater', async () => {
  const openAi = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  const adapter = createOpenAIAdapter(openAi, {
    model: 'gpt-4-1106-preview',
  });

  const rateJoke = createTool({
    description: 'Rate a joke',
    inputSchema: {
      type: 'object',
      properties: {
        joke: {
          type: 'string',
          description: 'The joke to rate',
        },
      },
    },
    run: async ({ topic }: { topic: string }) => {
      return `Here is a joke about ${topic}`;
    },
  });

  const createJoke = createTool({
    description: 'Create a joke',
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description: 'The category of the joke',
        },
      },
      required: ['category'],
    },
    run: async () => {
      return 'Some joke';
    },
  });

  const toolChoice = adapter.fromTool(
    (input: string) => `
The user provided this input:

<input>
${input}
</input>

Determine what to do:
- If the input is asking for a joke, create a joke,
- But if the input is providing a joke, then rate the joke.
    `,
    {
      rateJoke,
      createJoke,
    }
  );

  const actor = createActor(toolChoice, {
    // input: 'Why did the chicken cross the road? To get to the other side!',
    input: 'Tell me a joke about chickens',
  });

  actor.start();

  const res = await toPromise(actor);

  expect(res?.tool).toEqual('createJoke');
  expect(res?.result).toEqual('Some joke');

  const actor2 = createActor(toolChoice, {
    input:
      'Check this joke out: Why did the chicken cross the road? To get to the other side!',
  });

  actor2.start();

  const res2 = await toPromise(actor2);
  expect(res2?.tool).toEqual('rateJoke');
});

test.only('fromEvent - ', async () => {
  const openAi = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  const adapter = createOpenAIAdapter(openAi, {
    model: 'gpt-3.5-turbo',
  });

  const schemas = createSchemas({
    context: {
      storedNumberStr: {
        type: 'string',
        description: 'The stored number',
      },
      label: {
        type: 'string',
        description: 'The label of the number',
      },
    },
    events: {
      'number.evaluate': {
        description:
          'Evaluate whether the number passed as input is even or odd.',
        properties: {
          numberStr: {
            type: 'string',
            description: 'The input number string to evaluate',
          },
        },
      },
      proclaimEvenNumber: {
        description: 'Show the even number',
        properties: {},
      },
      proclaimOddNumber: {
        description: 'Show the odd number',
        properties: {},
      },
    },
  });

  const machine = setup({
    schemas,
    types: schemas.types,
    actions: {
      storeNumber: assign({
        storedNumberStr: (_, params: { numberStr: string }) => params.numberStr,
      }),
      labelNumberAsEven: assign({ label: 'Even' }),
      labelNumberAsOdd: assign({ label: 'Odd' }),
    },
    actors: {
      evaluate: adapter.fromEvent(
        (input: string) =>
          `Decide what to do based on the given input, which may be an even number or an odd number: ${input}`
      ),
    },
  }).createMachine({
    id: 'numberDisplayer',
    initial: 'idle',
    context: {
      storedNumberStr: '',
      label: '',
    },
    states: {
      idle: {
        on: {
          'number.evaluate': {
            target: 'evaluate',
            actions: [
              {
                type: 'storeNumber',
                params: ({ event }) => ({
                  numberStr: event.numberStr,
                }),
              },
            ],
          },
        },
      },
      evaluate: {
        invoke: {
          src: 'evaluate',
          input: ({ event }) => {
            if ('numberStr' in event) {
              return event.numberStr;
            }
            throw new Error('Invalid input');
          },
        },
        on: {
          proclaimEvenNumber: {
            target: 'done',
            actions: ['labelNumberAsEven'],
          },
          proclaimOddNumber: {
            target: 'done',
            actions: ['labelNumberAsOdd'],
          },
        },
      },
      done: {
        type: 'final',
      },
    },
    output: ({
      context,
    }: {
      context: { storedNumberStr: string; label: string };
    }) => ({
      storedNumberStr: context.storedNumberStr,
      label: context.label,
    }),
  });

  const actor = createActor(machine);
  actor.start();
  actor.send({
    type: 'number.evaluate',
    numberStr: 'two',
  });
  const res = (await toPromise(actor)) as ContextFrom<typeof machine>;

  expect(res.storedNumberStr).toBe('two');
  expect(res.label).toBe('Even');
});
