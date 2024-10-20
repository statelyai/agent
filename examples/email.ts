import { z } from 'zod';
import { createAgent, fromDecision } from '../src';
import { openai } from '@ai-sdk/openai';
import { assign, createActor, setup } from 'xstate';
import { fromTerminal } from './helpers/helpers';

const agent = createAgent({
  name: 'email',
  model: openai('gpt-4'),
  events: {
    askForClarification: z.object({
      questions: z.array(z.string()).describe('The questions to ask the agent'),
    }),
    submitEmail: z.object({
      email: z.string().describe('The email to submit'),
    }),
  },
});

const machine = setup({
  types: {
    events: agent.types.events,
    input: {} as {
      email: string;
      instructions: string;
    },
    context: {} as {
      email: string;
      instructions: string;
      clarifications: string[];
      replyEmail: string | null;
    },
  },
  actors: { agent: fromDecision(agent), getFromTerminal: fromTerminal },
}).createMachine({
  initial: 'checking',
  context: ({ input }) => ({
    email: input.email,
    instructions: input.instructions,
    clarifications: [],
    replyEmail: null,
  }),
  states: {
    checking: {
      invoke: {
        src: 'agent',
        input: ({ context }) => ({
          context: {
            email: context.email,
            instructions: context.instructions,
            clarifications: context.clarifications,
          },
          messages: agent.getMessages(),
          goal: 'Respond to the email given the instructions and the provided clarifications. If not enough information is provided, ask for clarification. Otherwise, if you are absolutely sure that there is no ambiguous or missing information, create and submit a response email.',
        }),
      },
      on: {
        askForClarification: {
          actions: ({ event }) => console.log(event.questions.join('\n')),
          target: 'clarifying',
        },
        submitEmail: {
          target: 'submitting',
        },
      },
    },
    clarifying: {
      invoke: {
        src: 'getFromTerminal',
        input: `Please provide answers to the questions above`,
        onDone: {
          actions: assign({
            clarifications: ({ context, event }) =>
              context.clarifications.concat(event.output),
          }),
          target: 'checking',
        },
      },
    },
    submitting: {
      invoke: {
        src: 'agent',
        input: ({ context }) => ({
          context: {
            email: context.email,
            instructions: context.instructions,
            clarifications: context.clarifications,
          },
          goal: `Create and submit an email based on the instructions.`,
        }),
      },
      on: {
        submitEmail: {
          actions: assign({
            replyEmail: ({ event }) => event.email,
          }),
          target: 'done',
        },
      },
    },
    done: {
      type: 'final',
      entry: ({ context }) => console.log(context.replyEmail),
    },
  },
  exit: () => {
    console.log('End of conversation.');
    process.exit();
  },
});

createActor(machine, {
  input: {
    email: 'That sounds great! When are you available?',
    instructions:
      'Tell them exactly when I am available. Address them by his full (first and last) name.',
  },
}).start();
