import { z } from 'zod';
import { createAgent } from '../src';
import { openai } from '@ai-sdk/openai';
import { assign, createActor, log, setup } from 'xstate';
import { getFromTerminal } from './helpers/helpers';

const agent = createAgent({
  name: 'goal',
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

const decider = agent.fromDecision();

const machine = setup({
  types: {
    context: {} as {
      question: string | null;
      goal: string | null;
    },
    events: agent.eventTypes,
  },
  actors: { decider, getFromTerminal },
}).createMachine({
  initial: 'gettingQuestion',
  context: {
    question: null,
    goal: null,
  },
  states: {
    gettingQuestion: {
      invoke: {
        src: 'getFromTerminal',
        input: 'What would you like to ask?',
        onDone: {
          actions: assign({
            question: ({ event }) => event.output,
          }),
          target: 'makingGoal',
        },
      },
    },
    makingGoal: {
      invoke: {
        src: 'decider',
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
        src: 'decider',
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
    responded: {
      type: 'final',
    },
  },
});

const actor = createActor(machine);

actor.start();
