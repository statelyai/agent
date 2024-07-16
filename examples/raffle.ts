import { z } from 'zod';
import { createAgent, fromDecision } from '../src';
import { openai } from '@ai-sdk/openai';
import { assign, createActor, log, setup } from 'xstate';
import { getFromTerminal } from './helpers/helpers';

const agent = createAgent({
  name: 'raffle-chooser',
  model: openai('gpt-4-turbo'),
  events: {
    'agent.collectEntries': z.object({}).describe('Collect more entries'),
    'agent.draw': z.object({}).describe('Draw a winner'),
    'agent.reportWinner': z.object({
      winningEntry: z.string().describe('The winning entry'),
      firstRunnerUp: z.string().describe('The first runner up entry'),
      secondRunnerUp: z.string().describe('The second runner up entry'),
      explanation: z
        .string()
        .describe('Explanation for why you chose the winning entry'),
    }),
  },
});

const machine = setup({
  types: {
    context: {} as {
      lastInput: string | null;
      entries: string[];
    },
    events: {} as typeof agent.types.events | { type: 'draw' },
  },
  actors: { agent: fromDecision(agent), getFromTerminal },
}).createMachine({
  /** @xstate-layout N4IgpgJg5mDOIC5QAoC2BDAxgCwJYDswBKAOjHwBcwAnAqAYggHtCSCA3JgazBLSzyFS5KrXxQEHJpnQVcLANoAGALrKViUAAcmsXHJaaQAD0QAmAOwBmEmYCsADgCMZgJxmALE4ceHSuwA0IACe5gBsZiR29q5KPnaOrmEOAL4pQfw4BMQkEGCiqAR09OgwlCSYTAA2VWCYFACilLRw6kY6egb4RqYIZg52JB52Ya5jSq5+To4eQaEILhYkA0qjVlYeSlsOYWFpGRhZQrn5NIX4xaUiudToAO5tSCAd+vLdT727SiRKHsl2FjCwxcrlmIUQTl2ticHk26ycMPsqXSIEyghyEFud0uZQoJGoYB01AoAHUCIRqI9tLpXoYPohXBYnCQnP4HK4nFYLF5vK45hCPDYmVtdk5uYzuWkUfgmHl4E80dkiO0aV0eogALRhfkIDWDMZjJn9MxhKwjSb7VGHdHCSg0OgqzpvdUIDxmHWc5l2caeKxhVYDFyWxXHPIFIriR2096gXoeVw2VmgiIOBzWJRiqwe2FRdzcpRWE0JPPB61Km73B1PF5q+kIPweEhWMWjCz+BJKJketwkQEWCyuOywv0WaJ2UsCcvY-AUqO12MQls-Ue+Px2KzspweoHLXxsjO-eNmMxSlJAA */
  context: {
    lastInput: null,
    entries: [],
  },
  initial: 'entering',
  states: {
    entering: {
      entry: log(({ context }) => context.entries),
      invoke: {
        src: 'getFromTerminal',
        input: 'What technology are you most interested in right now?',
        onDone: [
          {
            actions: assign({
              lastInput: ({ event }) => event.output,
            }),
            target: 'determining',
          },
        ],
      },
    },
    determining: {
      invoke: {
        src: 'agent',
        input: {
          context: true,
          goal: 'If the last input explicitly says to end the drawing and/or choose a winner, start the drawing process. Otherwise, get more entries.',
        },
      },
      on: {
        'agent.collectEntries': {
          target: 'entering',
          actions: assign({
            entries: ({ context }) => [...context.entries, context.lastInput!],
            lastInput: null,
          }),
        },
        'agent.draw': 'drawing',
      },
    },
    drawing: {
      entry: log('And the winner is...'),
      invoke: {
        src: 'agent',
        input: {
          context: true,
          goal: 'Choose the technology that sounds most exciting to you from the entries. Be as unbiased as possible in your choice. Explain why you chose the winning entry.',
        },
      },
      on: {
        'agent.reportWinner': {
          actions: log(
            ({ event }) =>
              `\n🎉🎉🎉 ${event.winningEntry} 🎉🎉🎉\n\n${event.explanation}`
          ),
          target: 'winner',
        },
      },
    },
    winner: {
      type: 'final',
    },
  },
  exit: () => {
    process.exit(0);
  },
});

const actor = createActor(machine);

actor.start();
