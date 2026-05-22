import { z } from 'zod';
import { execute } from '../src/local/index.js';
import {
  createAgentMachine,
  decide,
  decideResultSchema,
  type DecideAdapter,
} from '../src/index.js';
import {
  closePrompt,
  createOpenAiDecisionAdapter,
  formatResult,
  isMain,
  prompt,
} from './_run.js';

export function createAdapterExample(
  adapter: DecideAdapter = createOpenAiDecisionAdapter()
) {
  const routeOptions = {
    billing: {
      description: 'Send the request to billing support.',
      schema: z.object({ confidence: z.number().min(0).max(1) }),
    },
    general: {
      description: 'Handle the request in general support.',
      schema: z.object({ confidence: z.number().min(0).max(1) }),
    },
  } as const;

  return createAgentMachine({
    id: 'adapter-example',
    schemas: {
      input: z.object({ message: z.string() }),
      output: z.object({
        route: z.string().nullable(),
        confidence: z.number().nullable(),
      }),
    },
    context: (input) => ({
      message: input.message,
      route: null as string | null,
      confidence: null as number | null,
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
              'Route this support request.',
              'Return billing only when the request is clearly about invoices, refunds, or charges.',
              'Otherwise return general.',
              '',
              context.message,
            ].join('\n'),
            options: routeOptions,
            reasoning: false,
          }),
        onDone: ({ output }) => {
          return {
            target: 'done',
            context: {
              route: output.choice,
              confidence: output.data.confidence,
            },
          };
        },
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          route: context.route,
          confidence: context.confidence,
        }),
      },
    },
  });
}

async function main() {
  try {
    const message = await prompt('Message to route');
    const machine = createAdapterExample();

    console.log(formatResult(await execute(machine, machine.getInitialState({ message }))));
  } finally {
    closePrompt();
  }
}

if (isMain(import.meta.url)) {
  void main();
}
