import { z } from 'zod';
import { createAgent } from '../src';
import { openai } from '@ai-sdk/openai';
import { assign, createActor, log, setup } from 'xstate';

const agent = createAgent({
  model: openai('gpt-4-turbo'),
  events: {
    'agent.createGoal': z.object({
      goal: z.string().describe('The goal for the conversation'),
    }),
    'agent.respond': z.object({
      response: z.string().describe('The response from the agent'),
    }),
  },
});

const machine = setup({
  types: {
    context: {} as {
      question: string;
      goal: string | null;
    },
    events: agent.eventTypes,
    input: {} as { question: string },
  },
  actors: { agent },
}).createMachine({
  initial: 'makingGoal',
  context: ({ input }) => ({
    question: input.question,
    goal: null,
  }),
  states: {
    makingGoal: {
      invoke: {
        src: 'agent',
        input: {
          context: true,
          goal: 'Determine what the user wants to accomplish. What is their ideal goal state?',
          maxRetries: 3,
        },
      },
      on: {
        'agent.createGoal': {
          actions: [
            assign({
              goal: ({ event }) => event.goal,
            }),
            log((x) => x.event),
          ],
          target: 'responding',
        },
      },
    },
    responding: {
      invoke: {
        src: 'agent',
        input: {
          context: true,
          goal: 'Answer the question to achieve the stated goal, unless the goal is impossible to achieve.',
          maxRetries: 3,
        },
      },
      on: {
        'agent.respond': {
          actions: log(({ event }) => event),
        },
      },
    },
    responded: {},
  },
});

const actor = createActor(machine, {
  input: {
    question: 'What are the last 3 digits of pi?',
  },
});

actor.start();
