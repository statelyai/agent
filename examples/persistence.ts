import { z } from 'zod';
import { createMemoryRunStore, restoreSession, startSession, waitForRunDone, waitForRunSnapshot } from '../src/local/index.js';
import {
  createAgentMachine,
} from '../src/index.js';
import {
  closePrompt,
  generateExampleObject,
  isMain,
  prompt,
} from './_run.js';

const summarySchema = z.object({
  summary: z.string(),
});

export function createPersistenceExample(
  summarize: (args: {
    request: string;
    approved: boolean;
  }) => Promise<z.infer<typeof summarySchema>> = async (args) =>
    generateExampleObject({
      schema: summarySchema,
      system: 'You summarize approved requests in one concise sentence.',
      prompt: [
        `Request: ${args.request}`,
        `Approved: ${String(args.approved)}`,
        '',
        'Write a short summary.',
      ].join('\n'),
    })
) {
  return createAgentMachine({
    id: 'persistence-example',
    schemas: {
      input: z.object({
        request: z.string(),
      }),
      output: z.object({
        request: z.string(),
        approved: z.boolean(),
        summary: z.string().nullable(),
      }),
      events: {
        approve: z.object({}),
      },
    },
    context: (input) => ({
      request: input.request,
      approved: false,
      summary: null as string | null,
    }),
    initial: 'review',
    states: {
      review: {
        on: {
          approve: {
            target: 'summarizing',
            context: { approved: true },
          },
        },
      },
      summarizing: {
        schemas: { output: summarySchema },
        invoke: async ({ context }) =>
          summarize({
            request: context.request,
            approved: context.approved,
          }),
        onDone: ({ output }) => ({
          target: 'done',
          context: { summary: output.summary },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          request: context.request,
          approved: context.approved,
          summary: context.summary,
        }),
      },
    },
  });
}

export async function runPersistenceExample(
  input: { request: string },
  options: {
    summarize?: (args: {
      request: string;
      approved: boolean;
    }) => Promise<z.infer<typeof summarySchema>>;
  } = {}
) {
  const machine = createPersistenceExample(options.summarize);
  const store = createMemoryRunStore();

  const liveRun = await startSession(machine, {
    store,
    input,
  });

  await liveRun.send({ type: 'approve' });

  const restoredRun = await restoreSession(machine, {
    sessionId: liveRun.sessionId,
    store,
  });

  return {
    sessionId: liveRun.sessionId,
    liveSnapshot: liveRun.getSnapshot(),
    restoredSnapshot: restoredRun.getSnapshot(),
  };
}

async function main() {
  try {
    const request = await prompt('Request');
    const result = await runPersistenceExample({ request });
    console.log(result);
  } finally {
    closePrompt();
  }
}

if (isMain(import.meta.url)) {
  void main();
}
