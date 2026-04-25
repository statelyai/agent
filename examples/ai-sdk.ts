import { generateText, Output } from 'ai';
import { z } from 'zod';
import {
  createAgentMachine,
  decide,
  decideResultSchema,
  type AgentAdapter,
} from '../src/index.js';
import { createAiSdkAdapter } from '../src/ai-sdk/index.js';
import {
  closePrompt,
  createExampleModel,
  formatResult,
  isMain,
  prompt,
} from './_run.js';

const routeOptions = {
  billing: {
    description: 'Handle invoices, refunds, subscription charges, and payment issues.',
    schema: z.object({
      confidence: z.number().min(0).max(1),
    }),
  },
  support: {
    description: 'Handle product usage questions and troubleshooting requests.',
    schema: z.object({
      confidence: z.number().min(0).max(1),
    }),
  },
} as const;

const replySchema = z.object({
  subject: z.string(),
  body: z.string(),
});

type Route = keyof typeof routeOptions;

export function createAiSdkExample(options: {
  adapter?: AgentAdapter;
  draftReply?: (args: {
    route: Route;
    confidence: number;
    message: string;
  }) => Promise<z.infer<typeof replySchema>>;
} = {}) {
  const adapter =
    options.adapter ??
    createAiSdkAdapter({
      resolveModel: (model) => createExampleModel(model),
    });

  const draftReply =
    options.draftReply ??
    (async ({
      route,
      confidence,
      message,
    }: {
      route: Route;
      confidence: number;
      message: string;
    }) => {
      const result = await generateText({
        model: createExampleModel('openai/gpt-5.4-nano'),
        system: [
          'Draft a concise support email.',
          `Route: ${route}`,
          `Classifier confidence: ${confidence.toFixed(2)}`,
          'Return structured output with a subject and body.',
        ].join('\n'),
        prompt: message,
        output: Output.object({
          schema: replySchema,
        }),
      });

      return result.output as z.infer<typeof replySchema>;
    });

  return createAgentMachine({
    id: 'ai-sdk-example',
    schemas: {
      input: z.object({ message: z.string() }),
      output: z.object({
        route: z.enum(['billing', 'support']).nullable(),
        confidence: z.number().nullable(),
        subject: z.string().nullable(),
        body: z.string().nullable(),
      }),
    },
    context: (input) => ({
      message: input.message,
      route: null as Route | null,
      confidence: null as number | null,
      subject: null as string | null,
      body: null as string | null,
    }),
    initial: 'route',
    states: {
      route: {
        resultSchema: decideResultSchema(routeOptions),
        invoke: async ({ context }) =>
          decide({
            adapter,
            model: 'openai/gpt-5.4-nano',
            prompt: [
              'Route this inbound customer message.',
              '',
              context.message,
            ].join('\n'),
            options: routeOptions,
          }),
        onDone: ({ result }) => ({
          target: 'drafting',
          context: {
            route: result.choice,
            confidence: result.data.confidence,
          },
        }),
      },
      drafting: {
        resultSchema: replySchema,
        invoke: async ({ context }) =>
          draftReply({
            route: context.route ?? 'support',
            confidence: context.confidence ?? 0,
            message: context.message,
          }),
        onDone: ({ result }) => ({
          target: 'done',
          context: {
            subject: result.subject,
            body: result.body,
          },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          route: context.route,
          confidence: context.confidence,
          subject: context.subject,
          body: context.body,
        }),
      },
    },
  });
}

async function main() {
  try {
    const message = await prompt('Customer message');
    const machine = createAiSdkExample();
    const result = await machine.execute(machine.getInitialState({ message }));

    console.log(formatResult(result));
  } finally {
    closePrompt();
  }
}

if (isMain(import.meta.url)) {
  void main();
}
