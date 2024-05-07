import { createAgent } from '../src';
import { z } from 'zod';
import { setup, createActor } from 'xstate';
import { openai } from '@ai-sdk/openai';

const agent = createAgent({
  model: openai('gpt-3.5-turbo-16k-0613'),
  events: {
    'agent.thought': z.object({
      text: z.string().describe('The text of the thought'),
    }),
  },
});

const machine = setup({
  actors: { agent },
}).createMachine({
  initial: 'thinking',
  states: {
    thinking: {
      invoke: {
        src: 'agent',
        input: 'Think about a random topic, and then share that thought.',
      },
      on: {
        'agent.thought': {
          actions: ({ event }) => console.log(event.text),
          target: 'thought',
        },
      },
    },
    thought: {
      type: 'final',
    },
  },
});

const actor = createActor(machine).start();
