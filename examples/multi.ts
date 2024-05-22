import { createAgent } from '../src';
import { z } from 'zod';
import { assign, createActor, log, setup } from 'xstate';
import { getFromTerminal } from './helpers/helpers';
import { openai } from '@ai-sdk/openai';

const agent = createAgent({
  name: 'multi',
  model: openai('gpt-4-1106-preview'),
  events: {
    'agent.respond': z.object({
      response: z.string().describe('The response from the agent'),
    }),
  },
});

const machine = setup({
  types: {
    context: {} as {
      topic: string | null;
      discourse: string[];
    },
  },
  actors: {
    getFromTerminal,
    agent: agent.fromDecision(),
  },
}).createMachine({
  initial: 'asking',
  context: {
    topic: null,
    discourse: [],
  },
  states: {
    asking: {
      invoke: {
        src: 'getFromTerminal',
        input: 'What is the question?',
        onDone: {
          actions: assign({
            topic: ({ event }) => event.output,
          }),
          target: 'positiveResponse',
        },
      },
    },
    positiveResponse: {
      invoke: {
        src: 'agent',
        input: ({ context }) => ({
          context,
          goal: 'Debate the topic, and take the positive position. Respond directly to the last message of the discourse. Keep it short.',
        }),
      },
      on: {
        'agent.respond': {
          actions: [
            assign({
              discourse: ({ context, event }) =>
                context.discourse.concat(event.response),
            }),
            log(({ event }) => event.response),
          ],
          target: 'negativeResponse',
        },
      },
    },
    negativeResponse: {
      invoke: {
        src: 'agent',
        input: ({ context }) => ({
          model: openai('gpt-3.5-turbo-16k-0613'),
          context,
          goal: 'Debate the topic, and take the negative position. Respond directly to the last message of the discourse. Keep it short.',
        }),
      },
      on: {
        'agent.respond': {
          actions: [
            assign({
              discourse: ({ context, event }) =>
                context.discourse.concat(event.response),
            }),
            log(({ event }) => event.response),
          ],
          target: 'positiveResponse',
        },
      },
      always: {
        guard: ({ context }) => context.discourse.length >= 5,
        target: 'debateOver',
      },
    },
    debateOver: {
      type: 'final',
    },
  },
  exit: () => {
    process.exit();
  },
});

createActor(machine).start();
