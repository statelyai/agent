import assert from 'node:assert/strict';
import { z } from 'zod';
import { createActor, createAsyncLogic, toPromise } from 'xstate';
import { setupAgent } from '../../src/index.js';

export async function runCrewAIWriteABookExample() {
  const agent = setupAgent({
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

  const actor = createActor(
    machine.provide({
      actorSources: {
        outlineBook: agent.requests.outlineBook.withExecutor(async () => ({
          title: 'The Workflow Book',
          chapters: ['Intro', 'Runtime'],
        })),
      },
    }),
    { input: { brief: 'state machines for agents' } },
  );
  actor.start();
  await toPromise(actor);

  assert.deepEqual(actor.getSnapshot().output, {
    title: 'The Workflow Book',
    manuscript: 'Intro: body\nRuntime: body',
  });
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  await runCrewAIWriteABookExample();
}
