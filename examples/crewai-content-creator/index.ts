import assert from 'node:assert/strict';
import { z } from 'zod';
import { createActor, createAsyncLogic, toPromise } from 'xstate';
import { setupAgent } from '../../src/index.js';

export async function runCrewAIContentCreatorExample() {
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
          onDone: ({ output }) => ({
            target: 'creating',
            context: { route: output.route },
          }),
        },
      },
      creating: {
        invoke: {
          src: 'createContent',
          input: ({ context }) => ({
            route: context.route ?? 'blog',
            request: context.request,
          }),
          onDone: ({ output }) => ({
            target: 'done',
            context: { content: output },
          }),
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
      actorSources: {
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

  assert.deepEqual(actor.getSnapshot().output, {
    route: 'linkedin',
    content: 'Post for linkedin:launch update',
  });
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  await runCrewAIContentCreatorExample();
}
