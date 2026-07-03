import { z } from 'zod';
import { openai } from '@ai-sdk/openai';
import { createAsyncLogic } from 'xstate';
import {
  type AgentMessage,
  assistantMessage,
  createAgentSchemas,
  createTextLogic,
  setupAgent,
  userMessage,
} from '../../src/index.js';
import { type LanguageModel } from 'ai';

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

export const models: Record<'promptEvaluator' | 'emailDrafter' | 'draftStreamer', LanguageModel> = {
  promptEvaluator: openai('gpt-4.1-mini'),
  emailDrafter: openai('gpt-4.1-mini'),
  draftStreamer: openai('gpt-4.1-mini'),
} as const;

export const evaluatePrompt = createTextLogic({
  schemas: {
    input: z.object({ prompt: z.string() }),
    output: promptAssessmentSchema,
  },
  model: 'promptEvaluator',
  system:
    'Evaluate an email drafting request. Require recipient, subject, and body details. Return missing fields and one question per gap.',
  prompt: ({ input }) => input.prompt,
});

export const draftEmail = createTextLogic({
  schemas: {
    input: z.object({
      prompt: z.string(),
      messages: z.custom<AgentMessage[]>((value) => Array.isArray(value)),
    }),
    output: emailDraftSchema,
  },
  model: 'emailDrafter',
  system:
    'Draft a polished email from the request. Use the provided details without inventing missing essentials unless the user explicitly asked to draft anyway.',
  messages: ({ input }) => [
    ...input.messages,
    userMessage(input.prompt),
  ],
});

export const streamDraft = createTextLogic({
  mode: 'stream',
  schemas: {
    input: z.object({ prompt: z.string() }),
    output: z.string(),
  },
  model: 'draftStreamer',
  prompt: ({ input }) => input.prompt,
});

export const emailDrafterSchemas = createAgentSchemas({
  context: contextSchema,
  events: eventSchemas,
  output: outputSchema,
  meta: metaSchema,
});

export const emailDrafterActors = {
  sendEmail: createAsyncLogic<{ sent: boolean }, { draft: EmailDraft }>({
    run: async ({ input }) => {
      void input.draft;
      return { sent: true };
    },
  }),
  evaluatePrompt,
  draftEmail,
  streamDraft,
};

const agent = setupAgent({
  schemas: emailDrafterSchemas,
  models,
  actors: emailDrafterActors,
});

export const emailDrafter = agent.createMachine({
  id: 'email-drafter',
  output: ({ context }) => ({ sentEmails: context.sentEmails }),
  context: {
    prompt: '',
    assessment: null,
    draft: null,
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
        PROMPT_SUBMITTED: ({ event }) => ({
          target: 'evaluating',
          context: {
            prompt: event.prompt,
            assessment: null,
            draft: null,
            messages: [userMessage(event.prompt)],
          },
        }),
      },
    },

    evaluating: {
      invoke: {
        src: 'evaluatePrompt',
        input: ({ context }) => ({ prompt: context.prompt }),
        onDone: ({ output }) => {
          if (output.satisfied) {
            return {
              target: 'drafting',
              context: { assessment: output },
            };
          }

          return {
            target: 'needsMoreInfo',
            context: { assessment: output },
          };
        },
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
        MORE_INFO: ({ context, event }) => ({
          target: 'evaluating',
          context: {
            prompt: `${context.prompt}\n\n${event.details}`,
            messages: [...context.messages, userMessage(event.details)],
          },
        }),
        DRAFT_ANYWAY: ({ context }) => ({
          target: 'drafting',
          context: {
            prompt: `${context.prompt}\n\nDraft anyway with reasonable assumptions.`,
            messages: [
              ...context.messages,
              userMessage('Draft anyway with reasonable assumptions.'),
            ],
          },
        }),
      },
    },

    drafting: {
      invoke: {
        src: 'draftEmail',
        input: ({ context }) => ({
          prompt: context.prompt,
          messages: context.messages,
        }),
        onDone: ({ context, output }) => {
          const draft = output;
          return {
            target: 'reviewing',
            context: {
              draft,
              messages: [
                ...context.messages,
                assistantMessage(
                  `To: ${draft.to}\nSubject: ${draft.subject}\n\n${draft.body}`
                ),
              ],
            },
          };
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
        REQUEST_CHANGES: ({ context, event }) => ({
          target: 'drafting',
          context: {
            prompt: `${context.prompt}\n\nRevision request: ${event.changes}`,
            messages: [
              ...context.messages,
              userMessage(`Revision request: ${event.changes}`),
            ],
          },
        }),
        SEND: { target: 'sending' },
      },
    },

    sending: {
      invoke: {
        src: 'sendEmail',
        input: ({ context }) => ({ draft: context.draft! }),
        onDone: ({ context }) => ({
          target: 'sent',
          context: {
            sentEmails: context.draft
              ? [...context.sentEmails, context.draft]
              : context.sentEmails,
          },
        }),
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
          context: {
            prompt: '',
            assessment: null,
            draft: null,
          },
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
        MORE_INFO: ({ event }) => ({
          context: {
            // @ts-expect-error MORE_INFO carries `details`, not `changes`
            prompt: event.changes,
          },
        }),
      },
    },
    probeFinal: {
      type: 'final',
      output: ({ context }) => ({ sentEmails: context.sentEmails }),
    },
  },
});

// Root-level `output` is natively typed by XState against the output schema
agent.createMachine({
  context: {
    prompt: '',
    assessment: null,
    draft: null,
    sentEmails: [],
    messages: [],
  },
  // @ts-expect-error machine output is { sentEmails: EmailDraft[] }
  output: () => ({ wrong: true }),
  initial: 'probe',
  states: {
    probe: {
      type: 'final',
      // @ts-expect-error top-level final state output is { sentEmails: EmailDraft[] }
      output: () => ({ wrong: true }),
    },
  },
});

// named text logic: onDone output is typed from the logic output schema
agent.createMachine({
  context: {
    prompt: '',
    assessment: null,
    draft: null,
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
        onDone: ({ context, output }) => ({
          context: {
            messages: [
              ...context.messages,
              assistantMessage(output),
            ],
          },
        }),
      },
    },
  },
});
