import { z } from 'zod';
import { createAgentMachine } from '../src/index.js';
import {
  closePrompt,
  generateExampleObject,
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
    retrieve?: (question: string) => Promise<z.infer<typeof retrievedDocumentsSchema>>;
    answer?: (args: {
      question: string;
      documents: Array<z.infer<typeof retrievedDocumentSchema>>;
    }) => Promise<z.infer<typeof answerSchema>>;
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

  const answer =
    options.answer ??
    ((args: {
      question: string;
      documents: Array<z.infer<typeof retrievedDocumentSchema>>;
    }) =>
      generateExampleObject({
        schema: answerSchema,
        system: 'Answer the question using only the retrieved documents.',
        prompt: [
          `Question: ${args.question}`,
          '',
          'Documents:',
          ...args.documents.map((document) => `- [${document.id}] ${document.content}`),
        ].join('\n'),
      }));

  return createAgentMachine({
    id: 'rag-example',
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
        resultSchema: retrievedDocumentsSchema,
        invoke: async ({ context }) => retrieve(context.question),
        onDone: ({ result }) => ({
          target: 'answering',
          context: { documents: result.documents },
        }),
      },
      answering: {
        resultSchema: answerSchema,
        invoke: async ({ context }) =>
          answer({
            question: context.question,
            documents: context.documents,
          }),
        onDone: ({ result }) => ({
          target: 'done',
          context: { answer: result.answer },
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
