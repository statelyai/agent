import { z } from 'zod';
import { createAgentMachine } from '../src/index.js';
import {
  closePrompt,
  formatResult,
  generateExampleObject,
  isMain,
  prompt,
} from './_run.js';

const summarySchema = z.object({
  summary: z.string(),
});

export function createSimpleExample(
  summarize: (text: string) => Promise<z.infer<typeof summarySchema>> = async (
    text
  ) => {
    return generateExampleObject({
      schema: summarySchema,
      prompt: `Summarize this text in one sentence:\n\n${text}`,
    });
  }
) {
  return createAgentMachine({
    id: 'simple-example',
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
        resultSchema: summarySchema,
        invoke: async ({ context }) => summarize(context.text),
        onDone: ({ result }) => ({
          target: 'done',
          context: { summary: result.summary },
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
    const result = await machine.execute(machine.getInitialState({ text }));

    console.log(formatResult(result));
  } finally {
    closePrompt();
  }
}

if (isMain(import.meta.url)) {
  void main();
}
