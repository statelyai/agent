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
  id: 'typed-target-params',
  context: () => ({ count: 0 }),
  initial: 'idle',
  states: {
    idle: {
      on: {
        advance: () => ({
          target: 'working',
          params: {
            index: 0,
          },
        }),
      },
    },
    working: {
      paramsSchema: z.object({
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
  id: 'missing-required-target-params',
  context: () => ({ count: 0 }),
  initial: 'idle',
  states: {
    // @ts-expect-error params should be required when the target has paramsSchema
    idle: {
      on: {
        advance: () => ({
          target: 'working',
        }),
      },
    },
    working: {
      paramsSchema: z.object({
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
    // @ts-expect-error invalid targets should be rejected at author time
    idle: {
      on: {
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
  id: 'unexpected-target-params',
  context: () => ({ count: 0 }),
  initial: 'idle',
  states: {
    idle: {
      on: {
        // @ts-expect-error params should be rejected when the target has no paramsSchema
        advance: () => ({
          target: 'done',
          params: {
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
  id: 'invalid-target-params',
  context: () => ({ count: 0 }),
  initial: 'idle',
  states: {
    idle: {
      on: {
        // @ts-expect-error target params should match the target state's params schema
        advance: () => ({
          target: 'working',
          params: {
            wrong: true,
          },
        }),
      },
    },
    working: {
      paramsSchema: z.object({
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
        // @ts-expect-error target params should match the target param field types
        advance: () => ({
          target: 'working',
          params: {
            index: 'hello',
          },
        }),
      },
    },
    working: {
      paramsSchema: z.object({
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
