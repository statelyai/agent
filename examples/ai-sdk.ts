import { generateText, Output } from 'ai';
import { execute } from '../src/local/index.js';
import { z } from 'zod';
import {
  createAgentMachine,
  decide,
  decideResultSchema,
  type DecideAdapter,
} from '../src/index.js';
import { createAiSdkDecisionAdapter } from '../src/ai-sdk/index.js';
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
  adapter?: DecideAdapter;
  draftReply?: (args: {
    route: Route;
    confidence: number;
    message: string;
  }) => Promise<z.infer<typeof replySchema>>;
} = {}) {
  const adapter =
    options.adapter ??
    createAiSdkDecisionAdapter({
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
        schemas: { output: decideResultSchema(routeOptions) },
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
        onDone: ({ output }) => ({
          target: 'drafting',
          context: {
            route: output.choice,
            confidence: output.data.confidence,
          },
        }),
      },
      drafting: {
        schemas: { output: replySchema },
        invoke: async ({ context }) =>
          draftReply({
            route: context.route ?? 'support',
            confidence: context.confidence ?? 0,
            message: context.message,
          }),
        onDone: ({ output }) => ({
          target: 'done',
          context: {
            subject: output.subject,
            body: output.body,
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
    const result = await execute(machine, machine.getInitialState({ message }));

    console.log(formatResult(result));
  } finally {
    closePrompt();
  }
}

if (isMain(import.meta.url)) {
  void main();
}
