/**
 * CrewAI Write a Book with Flows — outline, then fan out chapter workers.
 *
 * CrewAI's Write a Book with Flows example outlines a book, then generates
 * each chapter and compiles a manuscript. Here `outlineBook` is a co-located
 * request and `writeChapters` is a typed host actor that fans out over the
 * outlined chapters — hosted with `runAgent` instead of manual
 * `createActor`/`toPromise` choreography.
 */
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createAsyncLogic } from 'xstate';
import { runAgent, setupAgent } from '../../src/index.js';
const models = {
  "outliner": "outliner",
} as const;


export async function runCrewAIWriteABookExample() {
  const agent = setupAgent({
    models,
    context: z.object({
      brief: z.string(),
      title: z.string().nullable(),
      chapters: z.array(z.string()),
      manuscript: z.string().nullable(),
    }),
    input: z.object({ brief: z.string() }),
    output: z.object({ title: z.string(), manuscript: z.string() }),
    actors: {
      writeChapters: createAsyncLogic<string[], { chapters: string[] }>({
        run: async ({ input }) =>
          input.chapters.map((chapter: string) => `${chapter}: body`),
      }),
    },
    requests: {
      outlineBook: {
        schemas: {
          input: z.object({ brief: z.string() }),
          output: z.object({
            title: z.string(),
            chapters: z.array(z.string()),
          }),
        },
        model: 'outliner',
        prompt: ({ input }) => input.brief,
      },
    },
  });

  const machine = agent.createMachine({
    id: 'crewai-write-book-xstate',
    context: ({ input }) => ({
      brief: input.brief,
      title: null,
      chapters: [],
      manuscript: null,
    }),
    initial: 'outlining',
    states: {
      outlining: {
        invoke: {
          src: 'outlineBook',
          input: ({ context }) => ({ brief: context.brief }),
          onDone: ({ output }) => ({
            target: 'writing',
            context: {
              title: output.title,
              chapters: output.chapters,
            },
          }),
        },
      },
      writing: {
        invoke: {
          src: 'writeChapters',
          input: ({ context }) => ({ chapters: context.chapters }),
          onDone: ({ output }) => ({
            target: 'done',
            context: { manuscript: output.join('\n') },
          }),
        },
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          title: context.title ?? '',
          manuscript: context.manuscript ?? '',
        }),
      },
    },
  });

  const result = await runAgent(machine, {
    input: { brief: 'state machines for agents' },
    generateText: async () => ({
      object: { title: 'The Workflow Book', chapters: ['Intro', 'Runtime'] },
    }),
  });

  if (result.status !== 'done') {
    throw new Error(`Write-a-book example did not complete: ${result.status}`);
  }
  assert.deepEqual(result.output, {
    title: 'The Workflow Book',
    manuscript: 'Intro: body\nRuntime: body',
  });
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  await runCrewAIWriteABookExample();
}
