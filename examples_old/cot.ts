import { z } from 'zod';
import { createAgent, fromDecision } from '../src';
import { openai } from '@ai-sdk/openai';
import { assign, createActor, log, setup } from 'xstate';
import { fromTerminal } from './helpers/helpers';

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
  context: {
    question: z.string().nullable(),
    thought: z.string().nullable(),
  },
});

const machine = setup({
  types: agent.types,
  actors: { agent: fromDecision(agent), getFromTerminal: fromTerminal },
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
            question: ({ event }) => event.output,
          }),
          target: 'thinking',
        },
      },
    },
    thinking: {
      invoke: {
        src: 'agent',
        input: ({ context }) => ({
          context,
          goal: 'Answer the question. Think step-by-step.',
        }),
      },
      on: {
        'agent.think': {
          actions: [
            log(({ event }) => event.thought),
            assign({
              thought: ({ event }) => event.thought,
            }),
          ],
          target: 'answering',
        },
      },
    },
    answering: {
      invoke: {
        src: 'agent',
        input: ({ context }) => ({
          context,
          goal: 'Answer the question',
        }),
      },
      on: {
        'agent.answer': {
          actions: [log(({ event }) => event.answer)],
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
