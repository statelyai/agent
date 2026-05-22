import { z } from 'zod';
import { execute } from '../src/local/index.js';
import { createAgentMachine } from '../src/index.js';
import {
  closePrompt,
  formatResult,
  generateExampleObject,
  isMain,
  prompt,
} from './_run.js';

const routeSchema = z.object({
  route: z.enum(['blog', 'linkedin', 'research']),
});

const contentSchema = z.object({
  title: z.string(),
  body: z.string(),
});

type ContentRoute = z.infer<typeof routeSchema>['route'];

export function createContentCreatorFlowExample(options: {
  routeRequest?: (request: string) => Promise<z.infer<typeof routeSchema>>;
  createBlog?: (request: string) => Promise<z.infer<typeof contentSchema>>;
  createLinkedInPost?: (request: string) => Promise<z.infer<typeof contentSchema>>;
  createResearchReport?: (request: string) => Promise<z.infer<typeof contentSchema>>;
} = {}) {
  const routeRequest =
    options.routeRequest ??
    ((request: string) =>
      generateExampleObject({
        schema: routeSchema,
        system:
          'Route content requests to blog, linkedin, or research. Choose research for analysis-heavy requests, linkedin for short professional posts, and blog for longer educational pieces.',
        prompt: request,
      }));

  const createBlog =
    options.createBlog ??
    ((request: string) =>
      generateExampleObject({
        schema: contentSchema,
        system: 'Write a concise professional blog post.',
        prompt: request,
      }));

  const createLinkedInPost =
    options.createLinkedInPost ??
    ((request: string) =>
      generateExampleObject({
        schema: contentSchema,
        system: 'Write a concise professional LinkedIn post.',
        prompt: request,
      }));

  const createResearchReport =
    options.createResearchReport ??
    ((request: string) =>
      generateExampleObject({
        schema: contentSchema,
        system: 'Write a concise research-style briefing with findings and implications.',
        prompt: request,
      }));

  return createAgentMachine({
    id: 'content-creator-flow-example',
    schemas: {
      input: z.object({
        request: z.string(),
      }),
      output: z.object({
        route: z.enum(['blog', 'linkedin', 'research']).nullable(),
        title: z.string().nullable(),
        body: z.string().nullable(),
      }),
    },
    context: (input) => ({
      request: input.request,
      route: null as ContentRoute | null,
      title: null as string | null,
      body: null as string | null,
    }),
    initial: 'routing',
    states: {
      routing: {
        schemas: { output: routeSchema },
        invoke: async ({ context }) => routeRequest(context.request),
        onDone: ({ output }) => ({
          target: 'creating',
          context: {
            route: output.route,
          },
        }),
      },
      creating: {
        schemas: { output: contentSchema },
        invoke: async ({ context }) => {
          switch (context.route) {
            case 'linkedin':
              return createLinkedInPost(context.request);
            case 'research':
              return createResearchReport(context.request);
            case 'blog':
            default:
              return createBlog(context.request);
          }
        },
        onDone: ({ output }) => ({
          target: 'done',
          context: {
            title: output.title,
            body: output.body,
          },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          route: context.route,
          title: context.title,
          body: context.body,
        }),
      },
    },
  });
}

async function main() {
  try {
    const request = await prompt('Content request');
    const machine = createContentCreatorFlowExample();
    const result = await execute(machine, machine.getInitialState({ request }));
    console.log(formatResult(result));
  } finally {
    closePrompt();
  }
}

if (isMain(import.meta.url)) {
  void main();
}
