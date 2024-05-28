import { createMachine, assign, createActor } from 'xstate';
import { createAgent } from '../src';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';

const agent = createAgent({
  name: 'espresso',
  model: openai('gpt-4'),
  events: {
    start: z.object({}).describe('Start the espresso machine'),
    grind: z.object({}).describe('Grind the beans'),
    heat: z.object({}).describe('Heat the water'),
    'combine milk and espresso': z
      .object({})
      .describe('Combine the steamed milk and espresso'),
    'add water': z.object({}).describe('Add water to the espresso'),
    'steam milk': z.object({}).describe('Add milk to the espresso'),
    'add cream': z.object({}).describe('Add cream to the espresso'),
    'add chocolate': z.object({}).describe('Add chocolate to the espresso'),
  },
});

export const espressoMachine = createMachine({
  id: 'espresso',
  context: {
    contents: {},
  },
  states: {
    idle: {
      entry: assign({
        contents: {},
      }),
      on: {
        start: 'preparing ingredients.beans',
      },
    },

    'preparing ingredients': {
      states: {
        beans: {
          states: {
            whole: {
              on: {
                grind: 'grinding',
              },
            },

            grinding: {
              after: {
                1000: 'ground',
              },
            },

            ground: {
              type: 'final',
            },
          },

          initial: 'whole',
        },

        water: {
          states: {
            start: {
              on: {
                heat: 'heating',
              },
            },

            heating: {
              after: {
                1000: 'heated',
              },
            },

            heated: {
              type: 'final',
            },
          },

          initial: 'start',
        },
      },

      initial: 'beans',
      onDone: { target: 'tamping' },
    },

    tamping: {
      after: {
        1000: {
          target: 'running espresso machine',
        },
      },
    },

    'running espresso machine': {
      after: {
        2000: {
          target: 'drink made',
          actions: assign({
            contents: ({ context }) => ({
              ...context.contents,
              espresso: 1,
            }),
          }),
        },
      },
    },

    'steaming milk': {
      after: {
        1000: 'milk steamed',
      },
    },

    'milk steamed': {
      on: {
        'combine milk and espresso': 'combining espresso and milk',
      },
    },

    'combining espresso and milk': {
      after: {
        1000: {
          target: 'drink made',
          actions: assign({
            contents: ({ context }) => ({
              ...context.contents,
              'steamed milk': 1,
            }),
          }),
        },
      },
    },

    'heating water': {
      after: {
        1000: 'combining espresso and water',
      },
    },

    'combining espresso and water': {
      after: {
        1000: {
          target: 'drink made',
          actions: assign({
            contents: ({ context }) => ({
              ...context.contents,
              'hot water': 1,
            }),
          }),
        },
      },
    },

    'drink made': {
      on: {
        'add water': 'heating water',
        'steam milk': 'steaming milk',
        'add cream': {
          actions: assign({
            contents: ({ context }) => ({
              ...context.contents,
              cream: 1,
            }),
          }),
        },

        'add chocolate': {
          actions: assign({
            contents: ({ context }) => ({
              ...context.contents,
              chocolate: 1,
            }),
          }),
        },

        restart: 'idle',
      },
    },
  },

  initial: 'idle',
});

const actor = createActor(espressoMachine);
actor.subscribe((s) => {
  console.log(s.value);
});
actor.start();

agent.interact(actor, {
  goal: 'Create a cappuccino',
  context: () => ({}),
});

agent.onMessage((m) => {
  console.log(m);
});

setTimeout(() => {}, 10000);
