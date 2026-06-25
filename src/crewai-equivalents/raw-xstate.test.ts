import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { assign, createActor, fromPromise, toPromise } from 'xstate';
import { setupAgent } from '../index.js';

describe('CrewAI-style flows authored as XState setup machines', () => {
  test('content creator routes and generates specialized content', async () => {
    const agent = setupAgent({
      context: z.object({
        request: z.string(),
        route: z.enum(['linkedin', 'blog']).nullable(),
        content: z.string().nullable(),
      }),
      input: z.object({ request: z.string() }),
      output: z.object({
        route: z.enum(['linkedin', 'blog']),
        content: z.string(),
      }),
      requests: {
        routeContent: {
          schemas: {
            input: z.object({ request: z.string() }),
            output: z.object({ route: z.enum(['linkedin', 'blog']) }),
          },
          model: 'router',
          prompt: ({ input }) => input.request,
        },
        createContent: {
          schemas: {
            input: z.object({
              route: z.enum(['linkedin', 'blog']),
              request: z.string(),
            }),
            output: z.string(),
          },
          model: 'writer',
          prompt: ({ input }) => `${input.route}:${input.request}`,
        },
      },
    });

    const machine = agent.createMachine({
      id: 'crewai-content-creator-xstate',
      context: ({ input }) => ({
        request: input.request,
        route: null,
        content: null,
      }),
      initial: 'routing',
      states: {
        routing: {
          invoke: {
            src: 'routeContent',
            input: ({ context }) => ({ request: context.request }),
            onDone: {
              target: 'creating',
              actions: assign({ route: ({ event }) => event.output.route }),
            },
          },
        },
        creating: {
          invoke: {
            src: 'createContent',
            input: ({ context }) => ({
              route: context.route ?? 'blog',
              request: context.request,
            }),
            onDone: {
              target: 'done',
              actions: assign({ content: ({ event }) => event.output }),
            },
          },
        },
        done: {
          type: 'final',
          output: ({ context }) => ({
            route: context.route ?? 'blog',
            content: context.content ?? '',
          }),
        },
      },
    });

    const actor = createActor(
      machine.provide({
        actors: {
          routeContent: agent.requests.routeContent.withExecutor(async () => ({
            route: 'linkedin',
          })),
          createContent: agent.requests.createContent.withExecutor(
            async ({ input }) => `Post for ${input.route}:${input.request}`,
          ),
        },
      }),
      { input: { request: 'launch update' } },
    );
    actor.start();
    await toPromise(actor);

    expect(actor.getSnapshot().output).toEqual({
      route: 'linkedin',
      content: 'Post for linkedin:launch update',
    });
  });

  test('write-a-book fans out chapter workers and compiles a manuscript', async () => {
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
        writeChapters: fromPromise<string[], { chapters: string[] }>(
          async ({ input }) =>
            input.chapters.map((chapter: string) => `${chapter}: body`),
        ),
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
            onDone: {
              target: 'writing',
              actions: assign({
                title: ({ event }) => event.output.title,
                chapters: ({ event }) => event.output.chapters,
              }),
            },
          },
        },
        writing: {
          invoke: {
            src: 'writeChapters',
            input: ({ context }) => ({ chapters: context.chapters }),
            onDone: {
              target: 'done',
              actions: assign({
                manuscript: ({ event }) => event.output.join('\n'),
              }),
            },
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
        actors: {
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

    expect(actor.getSnapshot().output).toEqual({
      title: 'The Workflow Book',
      manuscript: 'Intro: body\nRuntime: body',
    });
  });
});
