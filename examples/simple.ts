import { z } from 'zod';
import { execute } from '../src/local/index.js';
import { createAgentMachine, type AgentAdapter } from '../src/index.js';
import {
  closePrompt,
  createOpenAiGenerationAdapter,
  formatResult,
  isMain,
  prompt,
} from './_run.js';

const summarySchema = z.object({
  summary: z.string(),
});

export function createSimpleExample(
  adapter: AgentAdapter = createOpenAiGenerationAdapter()
) {
  return createAgentMachine({
    id: 'simple-example',
    adapter,
    schemas: {
      input: z.object({ text: z.string() }),
      output: z.object({ summary: z.string().nullable() }),
    },
    context: (input) => ({
      text: input.text,
      summary: null as string | null,
    }),
    initial: 'summarizing',
    states: {
      summarizing: {
        schemas: { output: summarySchema },
        prompt: ({ context }) =>
          `Summarize this text in one sentence:\n\n${context.text}`,
        onDone: ({ output }) => ({
          target: 'done',
          context: { summary: output.summary },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({ summary: context.summary }),
      },
    },
  });
}

async function main() {
  try {
    const text = await prompt('Text to summarize');
    const machine = createSimpleExample();
    const result = await execute(machine, machine.getInitialState({ text }));

    console.log(formatResult(result));
  } finally {
    closePrompt();
  }
}

if (isMain(import.meta.url)) {
  void main();
}
