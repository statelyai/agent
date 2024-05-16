import { createAgent } from '../src';
import { assign, createActor, fromPromise, log, setup } from 'xstate';
import { getFromTerminal } from './helpers/helpers';
import { z } from 'zod';
import { openai } from '@ai-sdk/openai';

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

const agent = createAgent({
  model: openai('gpt-4-1106-preview'),
  events: {
    'agent.getWeather': z.object({
      location: z.string().describe('The location to get the weather for'),
    }),
    'agent.reportWeather': z.object({
      location: z
        .string()
        .describe('The location the weather is being reported for'),
      highF: z.number().describe('The high temperature today in Fahrenheit'),
      lowF: z.number().describe('The low temperature today in Fahrenheit'),
      summary: z.string().describe('A summary of the weather conditions'),
    }),
    'agent.doSomethingElse': z
      .object({})
      .describe(
        'Do something else, because the user did not provide a location'
      ),
  },
});

const machine = setup({
  types: {
    context: {} as {
      location: string;
      history: string[];
      count: number;
    },
    events: agent.eventTypes,
  },
  actors: {
    agent: agent.fromDecision(),
    classifier: agent.fromObject(),
    getWeather,
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
        src: 'classifier',
        input: ({ context }) => ({
          context: {
            location: context.location,
          },
          schema: z.object({}),
          // goal: `Decide what to do based on the given location, which may or may not be a location`,
        }),
        onDone: {
          actions: (x) => x.event.output,
        },
      },
      on: {
        'agent.getWeather': {
          actions: log(({ event }) => event),
          target: 'gettingWeather',
        },
        'agent.doSomethingElse': 'getLocation',
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
          target: 'reportWeather',
        },
      },
    },
    reportWeather: {
      invoke: {
        src: 'agent',
        input: ({ context }) => ({
          goal: 'Report the weather', // TODO
        }),
      },
      on: {
        'agent.reportWeather': {
          actions: log(({ event }) => event),
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

const res = agent.generateObject({
  model: {} as any,
  schema: z.object({
    name: z.string(),
  }),
});

const actor = createActor(machine, {
  input: {
    location: 'New York',
  },
});
actor.subscribe((s) => {
  console.log(s.value);
});
actor.start();
