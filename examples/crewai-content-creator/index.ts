/**
 * CrewAI Content Creator — route-and-generate flow.
 *
 * CrewAI's Content Creator Flow routes a request to a format-specific
 * writer (LinkedIn vs. blog) and generates the content. Here that's two
 * co-located requests — `routeContent` then `createContent` — hosted with
 * `runAgent` instead of manual `createActor`/`toPromise` choreography.
 */
import assert from 'node:assert/strict';
import { z } from 'zod';
import { runAgent, setupAgent, type AgentTextRequest, type AgentTools } from '../../src/index.js';
const models = {
  "router": "router",
  "writer": "writer",
} as const;


export async function runCrewAIContentCreatorExample() {
  const agent = setupAgent({
    models,
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

  const generateText = async (request: AgentTextRequest & { tools: AgentTools }) => {
    if (request.model === 'router') {
      return { object: { route: 'linkedin' } };
    }
    // request.model === 'writer'; prompt is `${route}:${request}`.
    return `Post for ${request.prompt}`;
  };

  const result = await runAgent(machine, {
    input: { request: 'launch update' },
    generateText,
  });

  if (result.status !== 'done') {
    throw new Error(`Content creator example did not complete: ${result.status}`);
  }
  assert.deepEqual(result.output, {
    route: 'linkedin',
    content: 'Post for linkedin:launch update',
  });
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  await runCrewAIContentCreatorExample();
}
