import { z } from 'zod';
import { createAgentMachine } from './machine.js';

const machine = createAgentMachine({
  id: 'typed-targets',
  context: () => ({ count: 0 }),
  initial: 'idle',
  states: {
    idle: {
      on: {
        advance: () => ({
          target: 'done',
        }),
      },
    },
    done: {
      type: 'final',
    },
  },
  schemas: {
    events: {
      advance: z.object({
        type: z.literal('advance'),
      }),
    },
  },
});

machine.transition(machine.getInitialState(), { type: 'advance' });

createAgentMachine({
  id: 'typed-target-input',
  context: () => ({ count: 0 }),
  initial: 'idle',
  states: {
    idle: {
      on: {
        advance: () => ({
          target: 'working',
          input: {
            index: 0,
          },
        }),
      },
    },
    working: {
      inputSchema: z.object({
        index: z.number(),
      }),
    },
  },
  schemas: {
    events: {
      advance: z.object({
        type: z.literal('advance'),
      }),
    },
  },
});

const typedMachine = createAgentMachine({
  id: 'typed-surface',
  schemas: {
    input: z.object({
      task: z.string(),
    }),
    events: {
      submit: z.object({
        value: z.number(),
      }),
    },
    output: z.object({
      task: z.string(),
      total: z.number(),
    }),
  },
  context: (input) => ({
    task: input.task,
    total: 0,
  }),
  initial: 'idle',
  states: {
    idle: {
      on: {
        submit: ({ event }) => {
          event.value satisfies number;
          // @ts-expect-error invalid event payload property
          event.missing;
          return {
            target: 'done',
            context: { total: event.value },
          };
        },
      },
    },
    done: {
      type: 'final',
      output: ({ context }) => ({
        task: context.task,
        total: context.total,
      }),
    },
  },
});

typedMachine.getInitialState({ task: 'ship it' });
// @ts-expect-error missing required input
typedMachine.getInitialState();
// @ts-expect-error wrong input type
typedMachine.getInitialState({ task: 42 });

const typedState = typedMachine.getInitialState({ task: 'infer state values' });
typedState.value satisfies 'idle' | 'done';
// @ts-expect-error invalid state literal
typedState.value satisfies 'missing';

typedMachine.transition(typedState, { type: 'submit', value: 1 });
// @ts-expect-error invalid event type
typedMachine.transition(typedState, { type: 'missing' });
// @ts-expect-error invalid event payload
typedMachine.transition(typedState, { type: 'submit', value: 'nope' });

void (async () => {
  const result = await typedMachine.execute(
    typedMachine.transition(typedState, { type: 'submit', value: 2 })
  );

  if (result.status === 'done') {
    result.output.total satisfies number;
    result.output.task satisfies string;
    // @ts-expect-error no missing output property
    result.output.missing;
  }
})();

createAgentMachine({
  id: 'missing-required-target-input',
  context: () => ({ count: 0 }),
  initial: 'idle',
  states: {
    idle: {
      on: {
        // @ts-expect-error input should be required when the target has inputSchema
        advance: () => ({
          target: 'working',
        }),
      },
    },
    working: {
      inputSchema: z.object({
        index: z.number(),
      }),
    },
  },
  schemas: {
    events: {
      advance: z.object({
        type: z.literal('advance'),
      }),
    },
  },
});

createAgentMachine({
  id: 'invalid-target',
  context: () => ({ count: 0 }),
  initial: 'idle',
  states: {
    idle: {
      on: {
        // @ts-expect-error invalid targets should be rejected at author time
        advance: () => ({
          target: 'missing',
        }),
      },
    },
    done: {
      type: 'final',
    },
  },
  schemas: {
    events: {
      advance: z.object({
        type: z.literal('advance'),
      }),
    },
  },
});

createAgentMachine({
  id: 'unexpected-target-input',
  context: () => ({ count: 0 }),
  initial: 'idle',
  states: {
    idle: {
      on: {
        // @ts-expect-error input should be rejected when the target has no inputSchema
        advance: () => ({
          target: 'done',
          input: {
            anything: true,
          },
        }),
      },
    },
    done: {
      type: 'final',
    },
  },
  schemas: {
    events: {
      advance: z.object({
        type: z.literal('advance'),
      }),
    },
  },
});

createAgentMachine({
  id: 'invalid-target-input',
  context: () => ({ count: 0 }),
  initial: 'idle',
  states: {
    idle: {
      on: {
        // @ts-expect-error target input should match the target state's input schema
        advance: () => ({
          target: 'working',
          input: {
            wrong: true,
          },
        }),
      },
    },
    working: {
      inputSchema: z.object({
        index: z.number(),
      }),
    },
  },
  schemas: {
    events: {
      advance: z.object({
        type: z.literal('advance'),
      }),
    },
  },
});

createAgentMachine({
  id: 'invalid-target-param-types',
  context: () => ({ count: 0 }),
  initial: 'idle',
  states: {
    idle: {
      on: {
        // @ts-expect-error target input should match the target input field types
        advance: () => ({
          target: 'working',
          input: {
            index: 'hello',
          },
        }),
      },
    },
    working: {
      inputSchema: z.object({
        index: z.number(),
      }),
    },
  },
  schemas: {
    events: {
      advance: z.object({
        type: z.literal('advance'),
      }),
    },
  },
});
