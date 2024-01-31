 import { createAgent, fromEventChoice } from '../src';
import { assign, createActor, fromPromise, log, setup } from 'xstate';
import { getFromTerminal } from './helpers/helpers';
 import {ChatOpenAI, OpenAI} from "@langchain/openai";

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

const openai = new ChatOpenAI({
 });

const agent = createAgent(openai, {
  model: 'gpt-4-1106-preview',
  context: {
    location: { type: 'string' },
    history: { type: 'array', items: { type: 'string' } },
    count: { type: 'number' },
  },
  events: {
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
  },
});

const machine = setup({
  types: agent.types,
  actors: {
    searchTavily: fromPromise(async ({ input }: { input: string }) => {
      const results = await searchTavily(input, {
        maxResults: 5,
        apiKey: process.env.TAVILY_API_KEY!,
      });
      return results;
    }),
    decide: agent.fromEvent(
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
        src: 'searchTavily',
        input: ({ context }) =>
          `Get the weather for this location: ${context.location}`,
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

createActor(machine).start();
