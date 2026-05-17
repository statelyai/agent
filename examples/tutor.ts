import { z } from 'zod';
import { createAgentMachine } from '../src/index.js';
import {
  closePrompt,
  formatResult,
  generateExampleObject,
  isMain,
  prompt,
} from './_run.js';

const feedbackSchema = z.object({
  instruction: z.string(),
});

const responseSchema = z.object({
  response: z.string(),
});

export function createTutorExample(
  options: {
    teach?: (message: string) => Promise<z.infer<typeof feedbackSchema>>;
    respond?: (message: string) => Promise<z.infer<typeof responseSchema>>;
  } = {}
) {
  const teach =
    options.teach ??
    ((message: string) =>
      generateExampleObject({
        schema: feedbackSchema,
        system: 'You are a Spanish tutor giving concise corrective feedback in English.',
        prompt: `Give one short piece of coaching feedback for this learner message: ${message}`,
      }));
  const respond =
    options.respond ??
    ((message: string) =>
      generateExampleObject({
        schema: responseSchema,
        system: 'You are a friendly Spanish tutor. Reply in simple Spanish.',
        prompt: `Respond to this learner message in simple Spanish and keep the conversation going: ${message}`,
      }));

  return createAgentMachine({
    id: 'tutor-example',
    schemas: {
      input: z.object({ message: z.string() }),
      output: z.object({
        conversation: z.array(z.string()),
        feedback: z.string().nullable(),
        response: z.string().nullable(),
      }),
    },
    context: (input) => ({
      conversation: [`User: ${input.message}`],
      feedback: null as string | null,
      response: null as string | null,
    }),
    initial: 'teaching',
    states: {
      teaching: {
        schemas: { output: feedbackSchema },
        invoke: async ({ context }) =>
          teach(context.conversation.at(-1)?.replace(/^User:\s*/, '') ?? ''),
        onDone: ({ output }) => ({
          target: 'responding',
          context: { feedback: output.instruction },
        }),
      },
      responding: {
        schemas: { output: responseSchema },
        invoke: async ({ context }) =>
          respond(context.conversation.at(-1)?.replace(/^User:\s*/, '') ?? ''),
        onDone: ({ output, context }) => ({
          target: 'done',
          context: {
            response: output.response,
            conversation: [...context.conversation, `Tutor: ${output.response}`],
          },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          conversation: context.conversation,
          feedback: context.feedback,
          response: context.response,
        }),
      },
    },
  });
}

async function main() {
  try {
    const message = await prompt('Say something in Spanish');
    const machine = createTutorExample();
    console.log(formatResult(await machine.execute(machine.getInitialState({ message }))));
  } finally {
    closePrompt();
  }
}

if (isMain(import.meta.url)) {
  void main();
}
