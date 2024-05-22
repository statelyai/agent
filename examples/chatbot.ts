import { z } from 'zod';
import { createAgent } from '../src';
import { openai } from '@ai-sdk/openai';
import { assign, createActor, setup } from 'xstate';
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
});

const machine = setup({
  types: {
    context: {} as {
      conversation: string[];
    },
    events: agent.eventTypes,
  },
  actors: { agent: agent.fromDecision(), getFromTerminal },
}).createMachine({
  initial: 'waiting',
  context: {
    conversation: [],
  },
  always: {
    actions: (x) => console.log(x.context.conversation),
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
          actions: assign({
            conversation: (x) =>
              x.context.conversation.concat('Assistant: ' + x.event.response),
          }),
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
