import { z } from 'zod';
import { createAgent } from '../src';
import { openai } from '@ai-sdk/openai';
import { createActor, setup } from 'xstate';
import { getFromTerminal } from './helpers/helpers';

const agent = createAgent({
  model: openai('gpt-4-turbo'),
  events: {
    'agent.respond': z.object({
      response: z.string().describe('The response from the agent'),
    }),
    'agent.endConversation': z.object({}).describe('Stop the conversation'),
  },
});

const machine = setup({
  types: {
    events: agent.eventTypes,
  },
  actors: { agent: agent.fromDecision(), getFromTerminal },
}).createMachine({
  initial: 'waiting',
  states: {
    waiting: {
      invoke: {
        src: 'getFromTerminal',
        input: 'User:',
        onDone: 'responding',
      },
    },
    responding: {
      invoke: {
        src: 'agent',
        input: () => ({
          goal: 'Respond to the user, unless they want to end the conversation.',
          messages: agent.getSnapshot().context.history,
        }),
      },
      on: {
        'agent.respond': {
          actions: (x) => console.log(x.event.response),
          target: 'waiting',
        },
        'agent.endConversation': 'finished',
      },
    },
    finished: {
      type: 'final',
    },
  },
  exit: () => {
    console.log('End of conversation.');
    process.exit();
  },
});

const actor = createActor(machine).start();
