import { z } from 'zod';
import { createAgentMachine, type AgentAdapter } from '../src/index.js';
import {
  closePrompt,
  createOpenAiGenerationAdapter,
  isMain,
  prompt,
} from './_run.js';

const retrievedDocumentSchema = z.object({
  id: z.string(),
  content: z.string(),
});

const retrievedDocumentsSchema = z.object({
  documents: z.array(retrievedDocumentSchema),
});

const answerSchema = z.object({
  answer: z.string(),
});

export function createRagExample(
  options: {
    adapter?: AgentAdapter;
    retrieve?: (question: string) => Promise<z.infer<typeof retrievedDocumentsSchema>>;
  } = {}
) {
  const retrieve =
    options.retrieve ??
    ((question: string) =>
      Promise.resolve({
        documents: [
          {
            id: 'doc-1',
            content: `Context about: ${question}`,
          },
          {
            id: 'doc-2',
            content: `Additional supporting detail for: ${question}`,
          },
        ],
      }));

  return createAgentMachine({
    id: 'rag-example',
    adapter: options.adapter ?? createOpenAiGenerationAdapter(),
    schemas: {
      input: z.object({
        question: z.string(),
      }),
      output: z.object({
        question: z.string(),
        documents: z.array(retrievedDocumentSchema),
        answer: z.string().nullable(),
      }),
    },
    context: (input) => ({
      question: input.question,
      documents: [] as Array<z.infer<typeof retrievedDocumentSchema>>,
      answer: null as string | null,
    }),
    initial: 'retrieving',
    states: {
      retrieving: {
        schemas: { output: retrievedDocumentsSchema },
        invoke: async ({ context }) => retrieve(context.question),
        onDone: ({ output }) => ({
          target: 'answering',
          context: { documents: output.documents },
        }),
      },
      answering: {
        schemas: { output: answerSchema },
        system: 'Answer the question using only the retrieved documents.',
        prompt: ({ context }) =>
          [
            `Question: ${context.question}`,
            '',
            'Documents:',
            ...context.documents.map((document) => `- [${document.id}] ${document.content}`),
          ].join('\n'),
        onDone: ({ output }) => ({
          target: 'done',
          context: { answer: output.answer },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          question: context.question,
          documents: context.documents,
          answer: context.answer,
        }),
      },
    },
  });
}

async function main() {
  try {
    const question = await prompt('Question');
    const machine = createRagExample();
    const result = await machine.execute(
      machine.getInitialState({ question })
    );

    if (result.status === 'done') {
      console.log(result.output);
    }
  } finally {
    closePrompt();
  }
}

if (isMain(import.meta.url)) {
  void main();
}
