import { z } from 'zod';
import { createAgentMachine } from '../src/index.js';
import {
  closePrompt,
  formatResult,
  generateExampleObject,
  isMain,
  prompt,
} from './_run.js';

const postSchema = z.object({
  post: z.string(),
});

const evaluationSchema = z.object({
  valid: z.boolean(),
  feedback: z.string().nullable(),
});

export function createSelfEvaluationLoopFlowExample(options: {
  generatePost?: (args: {
    topic: string;
    feedback: string | null;
    attempt: number;
  }) => Promise<z.infer<typeof postSchema>>;
  evaluatePost?: (post: string) => Promise<z.infer<typeof evaluationSchema>>;
  maxAttempts?: number;
} = {}) {
  const generatePost =
    options.generatePost ??
    ((args: { topic: string; feedback: string | null; attempt: number }) =>
      generateExampleObject({
        schema: postSchema,
        system: 'Write a playful X post in a Shakespearean tone with no emojis and under 280 characters.',
        prompt: [
          `Topic: ${args.topic}`,
          `Attempt: ${args.attempt}`,
          args.feedback ? `Feedback to address: ${args.feedback}` : 'Feedback: none',
        ].join('\n'),
      }));

  const evaluatePost =
    options.evaluatePost ??
    ((post: string) =>
      generateExampleObject({
        schema: evaluationSchema,
        system:
          'Validate whether the X post is under 280 characters, uses no emojis, and stays playful. Return feedback only when it should be revised.',
        prompt: post,
      }));

  return createAgentMachine({
    id: 'self-evaluation-loop-flow-example',
    schemas: {
      input: z.object({
        topic: z.string(),
      }),
      output: z.object({
        post: z.string().nullable(),
        valid: z.boolean(),
        feedback: z.string().nullable(),
        attempt: z.number(),
      }),
    },
    context: (input) => ({
      topic: input.topic,
      post: null as string | null,
      valid: false,
      feedback: null as string | null,
      attempt: 1,
      maxAttempts: options.maxAttempts ?? 3,
    }),
    initial: 'generating',
    states: {
      generating: {
        schemas: { output: postSchema },
        invoke: async ({ context }) =>
          generatePost({
            topic: context.topic,
            feedback: context.feedback,
            attempt: context.attempt,
          }),
        onDone: ({ output }) => ({
          target: 'evaluating',
          context: {
            post: output.post,
          },
        }),
      },
      evaluating: {
        schemas: { output: evaluationSchema },
        invoke: async ({ context }) => evaluatePost(context.post ?? ''),
        onDone: ({ output, context }) => ({
          target:
            output.valid || context.attempt >= context.maxAttempts
              ? 'done'
              : 'generating',
          context: {
            valid: output.valid,
            feedback: output.feedback,
            attempt: output.valid
              ? context.attempt
              : context.attempt + 1,
          },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          post: context.post,
          valid: context.valid,
          feedback: context.feedback,
          attempt: context.attempt,
        }),
      },
    },
  });
}

async function main() {
  try {
    const topic = await prompt('Topic');
    const machine = createSelfEvaluationLoopFlowExample();
    const result = await machine.execute(machine.getInitialState({ topic }));
    console.log(formatResult(result));
  } finally {
    closePrompt();
  }
}

if (isMain(import.meta.url)) {
  void main();
}
