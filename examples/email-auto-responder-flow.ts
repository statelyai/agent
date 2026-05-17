import { z } from 'zod';
import {
  createAgentMachine,
  createMemoryRunStore,
  restoreSession,
  startSession,
  type RunStore,
} from '../src/index.js';
import {
  closePrompt,
  formatResult,
  generateExampleObject,
  isMain,
  prompt,
} from './_run.js';

const incomingEmailSchema = z.object({
  id: z.string(),
  subject: z.string(),
  body: z.string(),
  sender: z.string(),
});

const draftResponseSchema = z.object({
  draft: z.string(),
});

type IncomingEmail = z.infer<typeof incomingEmailSchema>;

export function createEmailAutoResponderFlowExample(
  createDraft: (email: IncomingEmail) => Promise<z.infer<typeof draftResponseSchema>> = (
    email
  ) =>
    generateExampleObject({
      schema: draftResponseSchema,
      system: 'Write a concise professional email reply draft.',
      prompt: [
        `Sender: ${email.sender}`,
        `Subject: ${email.subject}`,
        '',
        email.body,
      ].join('\n'),
    })
) {
  return createAgentMachine({
    id: 'email-auto-responder-flow-example',
    schemas: {
      input: z.object({}),
      output: z.object({
        processedIds: z.array(z.string()),
        drafts: z.record(z.string(), z.string()),
      }),
      events: {
        'emails.received': z.object({
          emails: z.array(incomingEmailSchema),
        }),
        stop: z.object({}),
      },
    },
    context: () => ({
      queue: [] as IncomingEmail[],
      currentEmail: null as IncomingEmail | null,
      processedIds: [] as string[],
      drafts: {} as Record<string, string>,
    }),
    initial: 'waiting',
    states: {
      waiting: {
        on: {
          'emails.received': ({ context, event }) => {
            const nextQueue = [...context.queue, ...event.emails].filter(
              (email) =>
                !context.processedIds.includes(email.id)
                && email.id !== context.currentEmail?.id
            );
            const [currentEmail, ...queue] = nextQueue;

            if (!currentEmail) {
              return {
                context: {
                  queue,
                },
              };
            }

            return {
              target: 'drafting',
              context: {
                currentEmail,
                queue,
              },
            };
          },
          stop: {
            target: 'done',
          },
        },
      },
      drafting: {
        on: {
          'emails.received': ({ context, event }) => ({
            context: {
              queue: [...context.queue, ...event.emails].filter(
                (email) =>
                  !context.processedIds.includes(email.id)
                  && email.id !== context.currentEmail?.id
              ),
            },
          }),
          stop: {
            target: 'done',
          },
        },
        schemas: { output: draftResponseSchema },
        invoke: async ({ context }) => createDraft(context.currentEmail!),
        onDone: ({ output, context }) => {
          const currentEmail = context.currentEmail!;
          const processedIds = [...context.processedIds, currentEmail.id];
          const drafts = {
            ...context.drafts,
            [currentEmail.id]: output.draft,
          };
          const [nextEmail, ...queue] = context.queue;

          if (nextEmail) {
            return {
              target: 'drafting',
              context: {
                currentEmail: nextEmail,
                queue,
                processedIds,
                drafts,
              },
            };
          }

          return {
            target: 'waiting',
            context: {
              currentEmail: null,
              queue: [],
              processedIds,
              drafts,
            },
          };
        },
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          processedIds: context.processedIds,
          drafts: context.drafts,
        }),
      },
    },
  });
}

export async function runEmailAutoResponderFlowExample(
  emails: IncomingEmail[],
  options: {
    createDraft?: (email: IncomingEmail) => Promise<z.infer<typeof draftResponseSchema>>;
    store?: RunStore;
  } = {}
) {
  const machine = createEmailAutoResponderFlowExample(options.createDraft);
  const store = options.store ?? createMemoryRunStore();
  const run = await startSession(machine, {
    store,
    input: {},
  });

  await run.send({
    type: 'emails.received',
    emails,
  });

  return {
    sessionId: run.sessionId,
    snapshot: run.getSnapshot(),
    restoredSnapshot: (
      await restoreSession(machine, {
        sessionId: run.sessionId,
        store,
      })
    ).getSnapshot(),
  };
}

async function main() {
  try {
    const sender = await prompt('Sender');
    const subject = await prompt('Subject');
    const body = await prompt('Body');
    const result = await runEmailAutoResponderFlowExample([
      {
        id: 'email-1',
        sender,
        subject,
        body,
      },
    ]);

    console.log(formatResult({
      status:
        result.snapshot.status === 'done'
          ? 'done'
          : result.snapshot.status === 'error'
            ? 'error'
            : 'pending',
      state: {
        value: result.snapshot.value,
        context: result.snapshot.context,
        status: result.snapshot.status,
        input: result.snapshot.input,
      },
      output: result.snapshot.output,
      context: result.snapshot.context,
      error: result.snapshot.error,
    } as never));
  } finally {
    closePrompt();
  }
}

if (isMain(import.meta.url)) {
  void main();
}
