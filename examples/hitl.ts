import { z } from 'zod';
import { createAgentMachine } from '../src/index.js';
import {
  closePrompt,
  formatResult,
  generateExampleObject,
  isMain,
  prompt,
} from './_run.js';

const draftSchema = z.object({
  draft: z.string(),
});

export function createHitlExample(
  draftReply: (args: {
    task: string;
    notes: string[];
  }) => Promise<z.infer<typeof draftSchema>> = async ({ task, notes }) => {
    return generateExampleObject({
      schema: draftSchema,
      prompt: [
        `Task: ${task}`,
        '',
        'Use the notes below to draft a concise response:',
        ...notes.map((note, index) => `${index + 1}. ${note}`),
      ].join('\n'),
    });
  }
) {
  return createAgentMachine({
    id: 'hitl-example',
    schemas: {
      input: z.object({ task: z.string() }),
      events: {
        'user.message': z.object({ message: z.string() }),
        'user.approve': z.object({}),
        'user.cancel': z.object({}),
      },
    },
    context: (input) => ({
      task: input.task,
      notes: [] as string[],
      draft: null as string | null,
    }),
    initial: 'gathering',
    states: {
      gathering: {
        on: {
          'user.message': ({ context, event }) => ({
            context: {
              notes: context.notes.concat(event.message),
            },
          }),
          'user.approve': { target: 'drafting' },
          'user.cancel': { target: 'cancelled' },
        },
      },
      drafting: {
        resultSchema: draftSchema,
        invoke: async ({ context }) =>
          draftReply({
            task: context.task,
            notes: context.notes,
          }),
        onDone: ({ result }) => ({
          target: 'done',
          context: { draft: result.draft },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({ draft: context.draft }),
      },
      cancelled: {
        type: 'final',
        output: () => ({ cancelled: true }),
      },
    },
  });
}

async function main() {
  try {
    const task = await prompt('Task');
    const machine = createHitlExample();
    let state = await machine.invoke(machine.getInitialState({ task }));

    while (state.status === 'pending') {
      const message = await prompt('Add note, or type /approve or /cancel');

      if (message === '/approve') {
        state = machine.transition(state, { type: 'user.approve' });
        break;
      }

      if (message === '/cancel') {
        state = machine.transition(state, { type: 'user.cancel' });
        break;
      }

      state = machine.transition(state, {
        type: 'user.message',
        message,
      });
      console.log({
        status: state.status,
        value: state.value,
        context: state.context,
      });
    }

    console.log(formatResult(await machine.execute(state)));
  } finally {
    closePrompt();
  }
}

if (isMain(import.meta.url)) {
  void main();
}
