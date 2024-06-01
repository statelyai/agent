import { z } from 'zod';
import { createAgent } from '../src';
import { openai } from '@ai-sdk/openai';
import { assign, createActor, log, setup } from 'xstate';
import { getFromTerminal } from './helpers/helpers';
import { fromDecision } from '../src';

const agent = createAgent({
  name: 'chatbot',
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
    context: {} as {
      conversation: string[];
    },
    events: agent.eventTypes,
  },
  actors: { agent: fromDecision(agent), getFromTerminal },
}).createMachine({
  initial: 'waiting',
  context: {
    conversation: [],
  },
  states: {
    waiting: {
      invoke: {
        src: 'getFromTerminal',
        input: 'User:',
        onDone: {
          actions: assign({
            conversation: (x) =>
              x.context.conversation.concat('User: ' + x.event.output),
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
            conversation: x.context.conversation,
          },
          goal: 'Respond to the user, unless they want to end the conversation.',
        }),
      },
      on: {
        'agent.respond': {
          actions: [
            assign({
              conversation: (x) =>
                x.context.conversation.concat('Assistant: ' + x.event.response),
            }),
            log((x) => `Agent: ${x.event.response}`),
          ],
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

createActor(machine).start();
