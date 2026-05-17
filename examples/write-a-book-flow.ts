import { z } from 'zod';
import { createAgentMachine } from '../src/index.js';
import {
  closePrompt,
  formatResult,
  generateExampleObject,
  generateExampleText,
  isMain,
  prompt,
} from './_run.js';

const chapterOutlineSchema = z.object({
  title: z.string(),
  brief: z.string(),
});

const outlineSchema = z.object({
  title: z.string(),
  chapters: z.array(chapterOutlineSchema),
});

const chapterSchema = z.object({
  title: z.string(),
  content: z.string(),
});

const chapterBatchSchema = z.object({
  chapters: z.array(chapterSchema),
});

const manuscriptSchema = z.object({
  manuscript: z.string(),
});

type ChapterOutline = z.infer<typeof chapterOutlineSchema>;

export function createWriteABookFlowExample(options: {
  createOutline?: (args: {
    topic: string;
    goal: string;
  }) => Promise<z.infer<typeof outlineSchema>>;
  writeChapter?: (args: {
    title: string;
    brief: string;
    goal: string;
    topic: string;
  }) => Promise<z.infer<typeof chapterSchema>>;
  compileManuscript?: (args: {
    title: string;
    chapters: z.infer<typeof chapterSchema>[];
  }) => Promise<z.infer<typeof manuscriptSchema>>;
} = {}) {
  const createOutline =
    options.createOutline ??
    ((args: { topic: string; goal: string }) =>
      generateExampleObject({
        schema: outlineSchema,
        system: 'Create a concise non-fiction book outline.',
        prompt: [`Topic: ${args.topic}`, `Goal: ${args.goal}`].join('\n'),
      }));

  const writeChapter =
    options.writeChapter ??
    ((args: {
      title: string;
      brief: string;
      goal: string;
      topic: string;
    }) =>
      generateExampleObject({
        schema: chapterSchema,
        system: 'Write a concise but coherent book chapter.',
        prompt: [
          `Book topic: ${args.topic}`,
          `Book goal: ${args.goal}`,
          `Chapter title: ${args.title}`,
          `Chapter brief: ${args.brief}`,
        ].join('\n'),
      }));

  const compileManuscript =
    options.compileManuscript ??
    ((args: { title: string; chapters: z.infer<typeof chapterSchema>[] }) =>
      generateExampleObject({
        schema: manuscriptSchema,
        system: 'Compile chapters into a single clean markdown manuscript.',
        prompt: [
          `Title: ${args.title}`,
          '',
          ...args.chapters.map(
            (chapter) => `## ${chapter.title}\n\n${chapter.content}`
          ),
        ].join('\n'),
      }));

  return createAgentMachine({
    id: 'write-a-book-flow-example',
    schemas: {
      input: z.object({
        topic: z.string(),
        goal: z.string(),
      }),
      output: z.object({
        title: z.string().nullable(),
        outline: z.array(chapterOutlineSchema),
        chapters: z.array(chapterSchema),
        manuscript: z.string().nullable(),
      }),
    },
    context: (input) => ({
      topic: input.topic,
      goal: input.goal,
      title: null as string | null,
      outline: [] as ChapterOutline[],
      chapters: [] as z.infer<typeof chapterSchema>[],
      manuscript: null as string | null,
    }),
    initial: 'outlining',
    states: {
      outlining: {
        schemas: { output: outlineSchema },
        invoke: async ({ context }) =>
          createOutline({
            topic: context.topic,
            goal: context.goal,
          }),
        onDone: ({ output }) => ({
          target: 'writing',
          context: {
            title: output.title,
            outline: output.chapters,
          },
        }),
      },
      writing: {
        schemas: { output: chapterBatchSchema },
        invoke: async ({ context }) => {
          const chapters = await Promise.all(
            context.outline.map((chapter) =>
              writeChapter({
                title: chapter.title,
                brief: chapter.brief,
                goal: context.goal,
                topic: context.topic,
              })
            )
          );

          return { chapters };
        },
        onDone: ({ output }) => ({
          target: 'compiling',
          context: {
            chapters: output.chapters,
          },
        }),
      },
      compiling: {
        schemas: { output: manuscriptSchema },
        invoke: async ({ context }) =>
          compileManuscript({
            title: context.title ?? 'Untitled Book',
            chapters: context.chapters,
          }),
        onDone: ({ output }) => ({
          target: 'done',
          context: {
            manuscript: output.manuscript,
          },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          title: context.title,
          outline: context.outline,
          chapters: context.chapters,
          manuscript: context.manuscript,
        }),
      },
    },
  });
}

async function main() {
  try {
    const topic = await prompt('Book topic');
    const goal = await prompt('Book goal');
    const machine = createWriteABookFlowExample();
    const result = await machine.execute(machine.getInitialState({ topic, goal }));
    console.log(formatResult(result));
  } finally {
    closePrompt();
  }
}

if (isMain(import.meta.url)) {
  void main();
}
