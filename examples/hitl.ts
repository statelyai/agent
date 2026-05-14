import { z } from 'zod';
import {
  createAgentMachine,
  createMemoryRunStore,
  startSession,
  type AgentMessage,
} from '../src/index.js';
import {
  closePrompt,
  generateExampleObject,
  isMain,
  prompt,
  waitForRunSnapshot,
} from './_run.js';

const draftSchema = z.object({
  draft: z.string(),
});

export function createHitlExample(
  draftReply: (args: {
    task: string;
    messages: AgentMessage[];
  }) => Promise<z.infer<typeof draftSchema>> = async ({ task, messages }) => {
    return generateExampleObject({
      schema: draftSchema,
      prompt: [
        `Task: ${task}`,
        '',
        'Use the notes below to draft a concise response:',
        ...messages.map((message, index) => `${index + 1}. ${message.content}`),
      ].join('\n'),
    });
  }
) {
  return createAgentMachine({
    id: 'hitl-example',
    schemas: {
      input: z.object({ task: z.string() }),
      output: z.object({
        draft: z.string().nullable().optional(),
        cancelled: z.literal(true).optional(),
      }),
      events: {
        'user.message': z.object({ message: z.string() }),
        'user.approve': z.object({}),
        'user.cancel': z.object({}),
      },
    },
    context: (input) => ({
      task: input.task,
      draft: null as string | null,
    }),
    messages: [],
    initial: 'gathering',
    states: {
      gathering: {
        on: {
          'user.message': ({ messages, event }) => ({
            messages: messages.concat({ role: 'user', content: event.message }),
          }),
          'user.approve': { target: 'drafting' },
          'user.cancel': { target: 'cancelled' },
        },
      },
      drafting: {
        resultSchema: draftSchema,
        invoke: async ({ context, messages }) =>
          draftReply({
            task: context.task,
            messages,
          }),
        onDone: ({ result, messages }) => ({
          target: 'done',
          messages: messages.concat({ role: 'assistant', content: result.draft }),
          context: { draft: result.draft },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({ draft: context.draft ?? null }),
      },
      cancelled: {
        type: 'final',
        output: () => ({ cancelled: true as const }),
      },
    },
  });
}

async function main() {
  try {
    const task = await prompt('Task');
    const machine = createHitlExample();
    const run = await startSession(machine, {
      store: createMemoryRunStore(),
      input: { task },
    });

    while (true) {
      const snapshot = await waitForRunSnapshot(
        run,
        (nextSnapshot) => nextSnapshot.status !== 'active'
      );

      if (snapshot.status === 'done') {
        console.log({
          status: snapshot.status,
          value: snapshot.value,
          context: snapshot.context,
          messages: snapshot.messages,
          output: snapshot.output,
        });
        break;
      }

      const message = await prompt('Add note, or type /approve or /cancel');

      if (message === '/approve') {
        await run.send({ type: 'user.approve' });
        continue;
      }

      if (message === '/cancel') {
        await run.send({ type: 'user.cancel' });
        continue;
      }

      await run.send({
        type: 'user.message',
        message,
      });
      console.log({
        status: run.getSnapshot().status,
        value: run.getSnapshot().value,
        context: run.getSnapshot().context,
      });
    }
  } finally {
    closePrompt();
  }
}

if (isMain(import.meta.url)) {
  void main();
}
