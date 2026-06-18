import { z } from 'zod';
import { assign } from 'xstate';
import { createAgentSchemas, setupAgent } from '../../src/index.js';

export const triageSchema = z.object({
  sentiment: z.enum(['positive', 'neutral', 'negative']),
  category: z.enum(['billing', 'technical', 'other']),
  reply: z.string(),
});

const schemas = createAgentSchemas({
  context: z.object({
    ticket: z.string(),
    triage: triageSchema.nullable(),
  }),
  input: z.object({ ticket: z.string() }),
  output: triageSchema,
});

const triageAgent = setupAgent({ schemas }).withTasks({
  triageTicket: {
    schemas: {
      input: z.object({ ticket: z.string() }),
      output: triageSchema,
    },
    model: 'openai/gpt-5.4-nano',
    system:
      'Triage the support ticket: sentiment, category, and a short suggested reply.',
    prompt: ({ input }) => input.ticket,
  },
});

export const { triageTicket } = triageAgent.tasks;

export const triageSchemas = triageAgent.schemas;

export const triageMachine = triageAgent.createMachine({
  id: 'ticket-triage',
  context: ({ input }) => ({ ticket: input.ticket, triage: null }),
  initial: 'triaging',
  states: {
    triaging: {
      invoke: {
        id: 'triage',
        src: 'triageTicket',
        input: ({ context }) => ({ ticket: context.ticket }),
        onDone: {
          target: 'done',
          actions: assign({
            triage: ({ event }) => event.output,
          }),
        },
      },
    },
    done: {
      type: 'final',
      output: ({ context }) =>
        context.triage ?? { sentiment: 'neutral', category: 'other', reply: '' },
    },
  },
});
