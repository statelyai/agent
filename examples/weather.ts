import OpenAI from 'openai';
import { createAgent, createOpenAIAdapter, defineEvents } from '../src';
import { assign, fromPromise, log, setup } from 'xstate';
import { getFromTerminal } from './helpers/helpers';

async function searchTavily(
  input: string,
  options: {
    maxResults?: number;
    apiKey: string;
  }
) {
  const body: Record<string, unknown> = {
    query: input,
    max_results: options.maxResults,
    api_key: options.apiKey,
  };

  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const json = await response.json();
  if (!response.ok) {
    throw new Error(
      `Request failed with status code ${response.status}: ${json.error}`
    );
  }
  if (!Array.isArray(json.results)) {
    throw new Error(`Could not parse Tavily results. Please try again.`);
  }
  return JSON.stringify(json.results);
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const eventSchemas = defineEvents({
  getWeather: {
    description: 'Get the weather for a location',
    properties: {
      location: {
        type: 'string',
        description: 'The location to get the weather for',
      },
    },
  },
  doSomethingElse: {
    description:
      'Do something else, because the user did not provide a location',
    properties: {},
  },
});

const adapter = createOpenAIAdapter(openai, {
  model: 'gpt-4-1106-preview',
});

const getWeather = fromPromise(async ({ input }: { input: string }) => {
  const results = await searchTavily(
    `Get the weather for this location: ${input}`,
    {
      maxResults: 5,
      apiKey: process.env.TAVILY_API_KEY!,
    }
  );
  return results;
});

const machine = setup({
  schemas: eventSchemas,
  types: {
    context: {} as {
      location: string;
      history: string[];
      count: number;
    },
    events: eventSchemas.types,
  },
  actors: {
    getWeather,
    decide: adapter.fromEvent(
      (input: string) =>
        `Decide what to do based on the given input, which may or may not be a location: ${input}`
    ),
    getFromTerminal,
  },
}).createMachine({
  initial: 'getLocation',
  context: {
    location: '',
    count: 0,
    history: [],
  },
  states: {
    getLocation: {
      invoke: {
        src: 'getFromTerminal',
        input: 'Location?',
        onDone: {
          actions: assign({
            location: ({ event }) => event.output,
          }),
          target: 'decide',
        },
      },
      always: {
        guard: ({ context }) => context.count >= 3,
        target: 'stopped',
      },
    },
    decide: {
      entry: log('Deciding...'),
      invoke: {
        src: 'decide',
        input: ({ context }) => context.location,
      },
      on: {
        getWeather: {
          actions: log(({ event }) => event),
          target: 'gettingWeather',
        },
        doSomethingElse: 'getLocation',
      },
    },
    gettingWeather: {
      entry: log('Getting weather...'),
      invoke: {
        src: 'getWeather',
        input: ({ context }) => context.location,
        onDone: {
          actions: [
            log(({ event }) => event.output),
            assign({
              count: ({ context }) => context.count + 1,
            }),
          ],
          target: 'getLocation',
        },
      },
    },
    stopped: {
      entry: log('You have used up your search quota. Goodbye!'),
    },
  },
  exit: () => {
    process.exit();
  },
});

createAgent(machine, {
  input: {
    location: 'New York',
  },
}).start();
