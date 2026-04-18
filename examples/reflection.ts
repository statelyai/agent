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

const feedbackSchema = z.object({
  feedback: z.string().nullable(),
});

export function createReflectionExample(
  options: {
    draft?: (task: string) => Promise<z.infer<typeof draftSchema>>;
    reflect?: (args: {
      task: string;
      draft: string;
      revisionCount: number;
    }) => Promise<z.infer<typeof feedbackSchema>>;
    revise?: (args: {
      task: string;
      draft: string;
      feedback: string;
    }) => Promise<z.infer<typeof draftSchema>>;
    maxRevisions?: number;
  } = {}
) {
  const draft =
    options.draft ??
    ((task: string) =>
      generateExampleObject({
        schema: draftSchema,
        system: 'You write concise first drafts.',
        prompt: `Write a short draft for this task:\n\n${task}`,
      }));
  const reflect =
    options.reflect ??
    ((args: { task: string; draft: string; revisionCount: number }) =>
      generateExampleObject({
        schema: feedbackSchema,
        system: 'You critique drafts and return null when no more revision is needed.',
        prompt: [
          `Task: ${args.task}`,
          `Revision count: ${args.revisionCount}`,
          '',
          'Draft:',
          args.draft,
          '',
          'Return one concise revision note, or null if the draft is already good enough.',
        ].join('\n'),
      }));
  const revise =
    options.revise ??
    ((args: { task: string; draft: string; feedback: string }) =>
      generateExampleObject({
        schema: draftSchema,
        system: 'You revise drafts to address the provided feedback.',
        prompt: [
          `Task: ${args.task}`,
          `Feedback: ${args.feedback}`,
          '',
          'Current draft:',
          args.draft,
          '',
          'Revise the draft.',
        ].join('\n'),
      }));

  return createAgentMachine({
    id: 'reflection-example',
    schemas: {
      input: z.object({ task: z.string() }),
      output: z.object({
        task: z.string(),
        draft: z.string().nullable(),
        feedback: z.string().nullable(),
        revisionCount: z.number(),
      }),
    },
    context: (input) => ({
      task: input.task,
      draft: null as string | null,
      feedback: null as string | null,
      revisionCount: 0,
      maxRevisions: options.maxRevisions ?? 2,
    }),
    initial: 'drafting',
    states: {
      drafting: {
        resultSchema: draftSchema,
        invoke: async ({ context }) => draft(context.task),
        onDone: ({ result }) => ({
          target: 'reflecting',
          context: { draft: result.draft },
        }),
      },
      reflecting: {
        resultSchema: feedbackSchema,
        invoke: async ({ context }) =>
          reflect({
            task: context.task,
            draft: context.draft ?? '',
            revisionCount: context.revisionCount,
          }),
        onDone: ({ result, context }) => ({
          target:
            !result.feedback || context.revisionCount >= context.maxRevisions
              ? 'done'
              : 'revising',
          context: { feedback: result.feedback },
        }),
      },
      revising: {
        resultSchema: draftSchema,
        invoke: async ({ context }) =>
          revise({
            task: context.task,
            draft: context.draft ?? '',
            feedback: context.feedback ?? '',
          }),
        onDone: ({ result, context }) => ({
          target: 'reflecting',
          context: {
            draft: result.draft,
            revisionCount: context.revisionCount + 1,
          },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          task: context.task,
          draft: context.draft,
          feedback: context.feedback,
          revisionCount: context.revisionCount,
        }),
      },
    },
  });
}

async function main() {
  try {
    const task = await prompt('Task');
    const machine = createReflectionExample();
    console.log(formatResult(await machine.execute(machine.getInitialState({ task }))));
  } finally {
    closePrompt();
  }
}

if (isMain(import.meta.url)) {
  void main();
}
