import { createAgent, fromDecision } from '../src';
import { z } from 'zod';
import { setup, createActor } from 'xstate';
import { openai } from '@ai-sdk/openai';

const agent = createAgent({
  name: 'simple',
  model: openai('gpt-4o-mini'),
  events: {
    'agent.thought': z.object({
      text: z.string().describe('The text of the thought'),
    }),
  },
});

const machine = setup({
  actors: { agent: fromDecision(agent) },
}).createMachine({
  initial: 'thinking',
  states: {
    thinking: {
      invoke: {
        src: 'agent',
        input: {
          goal: 'Think about a random topic, and then share that thought.',
        },
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
