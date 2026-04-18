import { z } from 'zod';
import {
  createAgentMachine,
  classify,
  classifyResultSchema,
  type AgentAdapter,
} from '../src/index.js';
import {
  closePrompt,
  createOpenAiDecisionAdapter,
  formatResult,
  isMain,
  prompt,
} from './_run.js';

export function createClassifyExample(
  adapter: AgentAdapter = createOpenAiDecisionAdapter()
) {
  const categories = {
    billing: { description: 'Payments, invoices, refunds, and charges.' },
    technical: { description: 'Bugs, outages, and product issues.' },
    general: { description: 'Everything else.' },
  } as const;

  return createAgentMachine({
    id: 'classify-example',
    schemas: {
      input: z.object({ request: z.string() }),
      output: z.object({ category: z.string().nullable() }),
    },
    context: (input) => ({
      request: input.request,
      category: null as string | null,
    }),
    initial: 'routing',
    states: {
      routing: {
        resultSchema: classifyResultSchema(categories),
        invoke: async ({ context }) =>
          classify({
            adapter,
            model: 'openai/gpt-5.4-nano',
            prompt: `Classify this support request:\n\n${context.request}`,
            into: categories,
          }),
        onDone: ({ result }) => ({
          target: 'done',
          context: { category: result.category },
        }),
      },
      done: {
        // use input; category should always be defined when entering
        type: 'final',
        output: ({ context }) => ({ category: context.category }),
      },
    },
  });
}

async function main() {
  try {
    const request = await prompt('Support request');
    const machine = createClassifyExample();

    console.log(formatResult(await machine.execute(machine.getInitialState({ request }))));
  } finally {
    closePrompt();
  }
}

if (isMain(import.meta.url)) {
  void main();
}
