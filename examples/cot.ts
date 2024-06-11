import { z } from 'zod';
import { createAgent, fromDecision } from '../src';
import { openai } from '@ai-sdk/openai';
import { assign, createActor, log, setup } from 'xstate';
import { getFromTerminal } from './helpers/helpers';

const agent = createAgent({
  name: 'chain-of-thought',
  model: openai('gpt-4o'),
  events: {
    'agent.think': z.object({
      thought: z
        .string()
        .describe('The thought process to answering the question'),
    }),
    'agent.answer': z.object({
      answer: z.string().describe('The answer to the question'),
    }),
  },
});

const machine = setup({
  types: {
    context: {} as {
      question: string | null;
      thought: string | null;
    },
    events: agent.eventTypes,
  },
  actors: { agent: fromDecision(agent), getFromTerminal },
}).createMachine({
  initial: 'asking',
  context: {
    question: null,
    thought: null,
  },
  states: {
    asking: {
      invoke: {
        src: 'getFromTerminal',
        input: 'What would you like to ask?',
        onDone: {
          actions: assign({
            question: (x) => x.event.output,
          }),
          target: 'thinking',
        },
      },
    },
    thinking: {
      invoke: {
        src: 'agent',
        input: (x) => ({
          context: x.context,
          goal: 'Answer the question. Think step-by-step.',
        }),
      },
      on: {
        'agent.think': {
          actions: [
            log((x) => x.event.thought),
            assign({
              thought: (x) => x.event.thought,
            }),
          ],
          target: 'answering',
        },
      },
    },
    answering: {
      invoke: {
        src: 'agent',
        input: (x) => ({
          context: x.context,
          goal: 'Answer the question',
        }),
      },
      on: {
        'agent.answer': {
          actions: [log((x) => x.event.answer)],
          target: 'answered',
        },
      },
    },
    answered: {
      type: 'final',
    },
  },
});

createActor(machine).start();
