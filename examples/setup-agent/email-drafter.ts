import { z } from 'zod';
import { assign, fromPromise } from 'xstate';
import {
  addMessages,
  type AgentMessage,
  assistantMessage,
  setupAgent,
  userMessage,
} from '../../src/index.js';

const promptAssessmentSchema = z.object({
  satisfied: z.boolean(),
  missing: z.array(z.string()),
  questions: z.array(z.string()),
});

const emailDraftSchema = z.object({
  to: z.string(),
  subject: z.string(),
  body: z.string(),
});

type EmailDraft = z.infer<typeof emailDraftSchema>;

// State/transition meta is schema-typed: hosts get a typed interaction
// protocol instead of Record<string, unknown>.
const metaSchema = z.object({
  display: z.array(z.string()).optional(),
  interaction: z
    .discriminatedUnion('type', [
      z.object({
        type: z.literal('text'),
        label: z.string(),
        eventType: z.string(),
        field: z.string(),
      }),
      z.object({
        type: z.literal('select'),
        label: z.string(),
        choices: z.array(
          z.object({
            label: z.string(),
            eventType: z.string(),
            input: z
              .object({ type: z.literal('text'), label: z.string(), field: z.string() })
              .optional(),
          })
        ),
      }),
      z.object({
        type: z.literal('confirm'),
        label: z.string(),
        default: z.boolean().optional(),
        trueEventType: z.string(),
        falseEventType: z.string(),
      }),
    ])
    .optional(),
});

const contextSchema = z.object({
  prompt: z.string(),
  assessment: promptAssessmentSchema.nullable(),
  draft: emailDraftSchema.nullable(),
  draftAnyway: z.boolean(),
  sentEmails: z.array(emailDraftSchema),
  messages: z.custom<AgentMessage[]>((value) => Array.isArray(value)),
});

const eventSchemas = {
  PROMPT_SUBMITTED: z.object({ prompt: z.string() }),
  MORE_INFO: z.object({ details: z.string() }),
  DRAFT_ANYWAY: z.object({}),
  REQUEST_CHANGES: z.object({ changes: z.string() }),
  SEND: z.object({}),
  ANOTHER: z.object({}),
  END: z.object({}),
};

const outputSchema = z.object({ sentEmails: z.array(emailDraftSchema) });

const agent = setupAgent({
  context: contextSchema,
  events: eventSchemas,
  output: outputSchema,
  meta: metaSchema,
  actors: {
    sendEmail: fromPromise<{ sent: boolean }, { draft: EmailDraft }>(
      async ({ input }) => {
        void input.draft;
        return { sent: true };
      }
    ),
  },
}).withTasks({
  evaluatePrompt: {
    schemas: {
      input: z.object({ prompt: z.string() }),
      output: promptAssessmentSchema,
    },
    model: 'openai/gpt-5.4-nano',
    system:
      'Evaluate an email drafting request. Require recipient, subject, and body details. Return missing fields and one question per gap.',
    prompt: ({ input }) => input.prompt,
  },
  draftEmail: {
    schemas: {
      input: z.object({
        prompt: z.string(),
        draftAnyway: z.boolean(),
        messages: z.custom<AgentMessage[]>((value) => Array.isArray(value)),
      }),
      output: emailDraftSchema,
    },
    model: 'openai/gpt-5.4-nano',
    system: ({ input }) =>
      [
        'Draft a polished email from the request.',
        input.draftAnyway
          ? 'Infer reasonable details only because the user chose to draft anyway.'
          : 'Use the provided details without inventing missing essentials.',
      ].join('\n'),
    messages: ({ input }) => [
      ...input.messages,
      userMessage(input.prompt),
    ],
  },
  streamDraft: {
    kind: 'stream',
    schemas: {
      input: z.object({ prompt: z.string() }),
      output: z.string(),
    },
    model: 'openai/gpt-5.4-nano',
    prompt: ({ input }) => input.prompt,
  },
});

export const { evaluatePrompt, draftEmail, streamDraft } = agent.tasks;

export const emailDrafterSchemas = agent.schemas;

export const emailDrafter = agent.createMachine({
  id: 'email-drafter',
  context: {
    prompt: '',
    assessment: null,
    draft: null,
    draftAnyway: false,
    sentEmails: [],
    messages: [],
  },
  initial: 'prompting',
  states: {
    prompting: {
      meta: {
        interaction: {
          type: 'text',
          label: 'Email draft request',
          eventType: 'PROMPT_SUBMITTED',
          field: 'prompt',
        },
      },
      on: {
        PROMPT_SUBMITTED: {
          target: 'evaluating',
          actions: assign({
            prompt: ({ event }) => event.prompt,
            assessment: null,
            draft: null,
            draftAnyway: false,
            messages: addMessages(({ event }) => userMessage(event.prompt)),
          }),
        },
      },
    },

    evaluating: {
      invoke: {
        id: 'evaluatePrompt',
        src: 'evaluatePrompt',
        input: ({ context }) => ({ prompt: context.prompt }),
        onDone: [
          {
            guard: ({ event }) => event.output.satisfied,
            target: 'drafting',
            actions: assign({
              assessment: ({ event }) => event.output,
            }),
          },
          {
            target: 'needsMoreInfo',
            actions: assign({
              assessment: ({ event }) => event.output,
            }),
          },
        ],
        onError: { target: 'failed' },
      },
    },

    needsMoreInfo: {
      meta: {
        interaction: {
          type: 'select',
          label: 'Next',
          choices: [
            {
              label: 'Add details',
              eventType: 'MORE_INFO',
              input: { type: 'text', label: 'More details', field: 'details' },
            },
            { label: 'Draft anyway', eventType: 'DRAFT_ANYWAY' },
          ],
        },
      },
      on: {
        MORE_INFO: {
          target: 'evaluating',
          actions: assign({
            prompt: ({ context, event }) => `${context.prompt}\n\n${event.details}`,
            messages: addMessages(({ event }) => userMessage(event.details)),
          }),
        },
        DRAFT_ANYWAY: {
          target: 'drafting',
          actions: assign({ draftAnyway: true }),
        },
      },
    },

    drafting: {
      invoke: {
        id: 'draftEmail',
        src: 'draftEmail',
        input: ({ context }) => ({
          prompt: context.prompt,
          draftAnyway: context.draftAnyway,
          messages: context.messages,
        }),
        onDone: {
          target: 'reviewing',
          actions: assign({
            draft: ({ event }) => event.output,
            messages: addMessages(({ event }) => {
              const draft = event.output;
              return assistantMessage(
                `To: ${draft.to}\nSubject: ${draft.subject}\n\n${draft.body}`
              );
            }),
          }),
        },
        onError: { target: 'failed' },
      },
    },

    reviewing: {
      meta: {
        interaction: {
          type: 'select',
          label: 'Next',
          choices: [
            {
              label: 'Request changes',
              eventType: 'REQUEST_CHANGES',
              input: { type: 'text', label: 'Requested changes', field: 'changes' },
            },
            { label: 'Send', eventType: 'SEND' },
          ],
        },
      },
      on: {
        REQUEST_CHANGES: {
          target: 'drafting',
          actions: assign({
            prompt: ({ context, event }) =>
              `${context.prompt}\n\nRevision request: ${event.changes}`,
            draftAnyway: true,
            messages: addMessages(({ event }) =>
              userMessage(`Revision request: ${event.changes}`)
            ),
          }),
        },
        SEND: { target: 'sending' },
      },
    },

    sending: {
      invoke: {
        src: 'sendEmail',
        input: ({ context }) => ({ draft: context.draft! }),
        onDone: {
          target: 'sent',
          actions: assign({
            sentEmails: ({ context }) =>
              context.draft
                ? [...context.sentEmails, context.draft]
                : context.sentEmails,
          }),
        },
        onError: { target: 'failed' },
      },
    },

    sent: {
      meta: {
        display: ['Email sent.'],
        interaction: {
          type: 'confirm',
          label: 'Send another?',
          default: false,
          trueEventType: 'ANOTHER',
          falseEventType: 'END',
        },
      },
      on: {
        ANOTHER: {
          target: 'prompting',
          actions: assign({
            prompt: '',
            assessment: null,
            draft: null,
            draftAnyway: false,
          }),
        },
        END: { target: 'done' },
      },
    },

    // Plain final states: `output` is natively typed against the machine's
    // output schema, and becomes the machine output when reached.
    failed: {
      type: 'final',
      output: ({ context }) => ({ sentEmails: context.sentEmails }),
    },
    done: {
      type: 'final',
      output: ({ context }) => ({ sentEmails: context.sentEmails }),
    },
  },
});

// ─── Type probes: compilation fails if any of these stop being typed ───

agent.createMachine({
  context: {
    prompt: '',
    assessment: null,
    draft: null,
    draftAnyway: false,
    sentEmails: [],
    messages: [],
  },
  initial: 'probe',
  states: {
    probe: {
      meta: {
        // @ts-expect-error meta is schema-typed: 'banner' is not a valid interaction type
        interaction: { type: 'banner' },
      },
      on: {
        MORE_INFO: {
          actions: assign({
            // @ts-expect-error MORE_INFO carries `details`, not `changes`
            prompt: ({ event }) => event.changes,
          }),
        },
      },
    },
    probeFinal: {
      type: 'final',
      // @ts-expect-error machine output is { sentEmails: EmailDraft[] }
      output: () => 'not the machine output',
    },
  },
});

// Root-level `output` is natively typed by XState against the output schema
agent.createMachine({
  context: {
    prompt: '',
    assessment: null,
    draft: null,
    draftAnyway: false,
    sentEmails: [],
    messages: [],
  },
  // @ts-expect-error machine output is { sentEmails: EmailDraft[] }
  output: () => ({ wrong: true }),
  initial: 'probe',
  states: {
    probe: { type: 'final' },
  },
});

// named text logic: onDone output is typed from the logic output schema
agent.createMachine({
  context: {
    prompt: '',
    assessment: null,
    draft: null,
    draftAnyway: false,
    sentEmails: [],
    messages: [],
  },
  initial: 'streaming',
  states: {
    streaming: {
      invoke: {
        id: 'streamDraft',
        src: 'streamDraft',
        input: ({ context }) => ({ prompt: context.prompt }),
        onDone: {
          actions: assign({
            messages: addMessages(({ event }) => assistantMessage(event.output)),
          }),
        },
      },
    },
  },
});
