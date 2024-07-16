import { z } from 'zod';
import { createAgent, fromDecision } from '../src';
import { openai } from '@ai-sdk/openai';
import { assign, createActor, log, setup } from 'xstate';
import { getFromTerminal } from './helpers/helpers';

const agent = createAgent({
  name: 'chatbot',
  model: openai('gpt-4-turbo'),
  events: {
    'agent.respond': z.object({
      response: z.string().describe('The response from the agent'),
    }),
    'agent.endConversation': z.object({}).describe('Stop the conversation'),
  },
  context: {
    userMessage: z.string(),
  },
});

const machine = setup({
  types: agent.types,
  actors: { agent: fromDecision(agent), getFromTerminal },
}).createMachine({
  initial: 'listening',
  context: {
    userMessage: '',
  },
  states: {
    listening: {
      invoke: {
        src: 'getFromTerminal',
        input: 'User:',
        onDone: {
          actions: assign({
            userMessage: (x) => x.event.output,
          }),
          target: 'responding',
        },
      },
    },
    responding: {
      invoke: {
        src: 'agent',
        input: (x) => ({
          context: {
            userMessage: 'User says: ' + x.context.userMessage,
          },
          messages: agent.getMessages(),
          goal: 'Respond to the user, unless they want to end the conversation.',
        }),
      },
      on: {
        'agent.respond': {
          actions: [log((x) => `Agent: ${x.event.response}`)],
          target: 'listening',
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

createActor(machine).start();
