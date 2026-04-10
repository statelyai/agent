import { z } from 'zod';
import {
  createAgentMachine,
  classify,
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
  return createAgentMachine({
    id: 'classify-example',
    schemas: {
      input: z.object({ request: z.string() }),
    },
    context: (input) => ({
      request: input.request,
      category: null as string | null,
    }),
    adapter,
    initial: 'routing',
    states: {
      routing: classify({
        model: 'openai/gpt-5.4-nano',
        prompt: ({ context }) => `Classify this support request:\n\n${context.request}`,
        into: {
          billing: { description: 'Payments, invoices, refunds, and charges.' },
          technical: { description: 'Bugs, outages, and product issues.' },
          general: { description: 'Everything else.' },
        },
        onDone: ({ result }) => ({
          target: 'done',
          context: { category: result.category },
        }),
      }),
      done: {
        // use params; category should alwyas be defined when entering
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
