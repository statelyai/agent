import { z } from 'zod';
import { createAgentMachine } from '../src/index.js';
import {
  closePrompt,
  formatResult,
  generateExampleObject,
  isMain,
  prompt,
} from './_run.js';

const answerSchema = z.object({
  answer: z.string(),
});

export function createErrorRetryExample(
  answer: (args: {
    question: string;
    attempt: number;
  }) => Promise<z.infer<typeof answerSchema>> = async ({ question, attempt }) =>
    generateExampleObject({
      schema: answerSchema,
      system: 'Answer the user question in one concise paragraph.',
      prompt: [
        `Attempt: ${attempt}`,
        '',
        `Question: ${question}`,
      ].join('\n'),
    }),
  maxAttempts = 3
) {
  return createAgentMachine({
    id: 'error-retry-example',
    schemas: {
      input: z.object({
        question: z.string(),
      }),
      events: {
        'xstate.error.invoke.answering': z.object({
          type: z.literal('xstate.error.invoke.answering'),
          error: z.unknown().optional(),
          at: z.number().optional(),
        }),
      },
      output: z.object({
        answer: z.string().nullable(),
        attempts: z.number().int().min(1),
        errors: z.array(z.string()),
      }),
    },
    context: (input) => ({
      question: input.question,
      answer: null as string | null,
      attempt: 1,
      errors: [] as string[],
    }),
    initial: 'answering',
    states: {
      answering: {
        schemas: { output: answerSchema },
        invoke: async ({ context }) =>
          answer({
            question: context.question,
            attempt: context.attempt,
          }),
        onDone: ({ output }) => ({
          target: 'done',
          context: {
            answer: output.answer,
          },
        }),
        on: {
          'xstate.error.invoke.answering': ({ event, context }) => {
            const errors = [...context.errors, formatError(event.error)];

            if (context.attempt >= maxAttempts) {
              return {
                target: 'failed',
                context: { errors },
              };
            }

            return {
              target: 'answering',
              context: {
                attempt: context.attempt + 1,
                errors,
              },
            };
          },
        },
      },
      failed: {
        type: 'final',
        output: ({ context }) => ({
          answer: context.answer,
          attempts: context.attempt,
          errors: context.errors,
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          answer: context.answer,
          attempts: context.attempt,
          errors: context.errors,
        }),
      },
    },
  });
}

function formatError(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }

  return String(error);
}

async function main() {
  try {
    const question = await prompt('Question');
    const machine = createErrorRetryExample();
    const result = await machine.execute(machine.getInitialState({ question }));

    console.log(formatResult(result));
  } finally {
    closePrompt();
  }
}

if (isMain(import.meta.url)) {
  void main();
}
