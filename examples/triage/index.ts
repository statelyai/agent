import { z } from 'zod';
import { createAgentSchemas, createTextLogic, setupAgent } from '../../src/index.js';

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

export const triageTicket = createTextLogic({
  schemas: {
    input: z.object({ ticket: z.string() }),
    output: triageSchema,
  },
  model: 'openai/gpt-4.1-mini',
  system:
    'Triage the support ticket: sentiment, category, and a short suggested reply.',
  prompt: ({ input }) => input.ticket,
});

export const triageActors = {
  triageTicket,
};

const triageAgent = setupAgent({
  schemas,
  actors: triageActors,
});

export const triageSchemas = schemas;

export const triageMachine = triageAgent.createMachine({
  id: 'ticket-triage',
  output: ({ context }) =>
    context.triage ?? { sentiment: 'neutral', category: 'other', reply: '' },
  context: ({ input }) => ({ ticket: input.ticket, triage: null }),
  initial: 'triaging',
  states: {
    triaging: {
      invoke: {
        id: 'triage',
        src: 'triageTicket',
        input: ({ context }) => ({ ticket: context.ticket }),
        onDone: ({ output }) => ({
          target: 'done',
          context: { triage: output },
        }),
      },
    },
    done: {
      type: 'final',
    },
  },
});
