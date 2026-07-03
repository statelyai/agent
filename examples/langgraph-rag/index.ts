import assert from 'node:assert/strict';
import { z } from 'zod';
import { createAsyncLogic } from 'xstate';
import { runAgent, setupAgent } from '../../src/index.js';
const models = {
  "answerer": "answerer",
} as const;


export async function runLangGraphRAGExample() {
  const agent = setupAgent({
    models,
    context: z.object({
      question: z.string(),
      documents: z.array(z.string()),
      answer: z.string().nullable(),
    }),
    input: z.object({ question: z.string() }),
    output: z.object({ answer: z.string() }),
    actors: {
      retrieve: createAsyncLogic<string[], { question: string }>({
        run: async ({ input }) => [`doc:${input.question}`, 'doc:typed state'],
      }),
    },
    requests: {
      answerQuestion: {
        schemas: {
          input: z.object({
            question: z.string(),
            documents: z.array(z.string()),
          }),
          output: z.string(),
        },
        model: 'answerer',
        prompt: ({ input }) =>
          `Q: ${input.question}\nDocs:\n${input.documents.join('\n')}`,
      },
    },
  });

  const machine = agent.createMachine({
    id: 'raw-xstate-rag',
    context: ({ input }) => ({
      question: input.question,
      documents: [],
      answer: null,
    }),
    initial: 'retrieving',
    states: {
      retrieving: {
        invoke: {
          src: 'retrieve',
          input: ({ context }) => ({ question: context.question }),
          onDone: ({ output }) => ({
            target: 'answering',
            context: { documents: output },
          }),
        },
      },
      answering: {
        invoke: {
          src: 'answerQuestion',
          input: ({ context }) => ({
            question: context.question,
            documents: context.documents,
          }),
          onDone: ({ output }) => ({
            target: 'done',
            context: { answer: output },
          }),
        },
      },
      done: {
        type: 'final',
        output: ({ context }) => ({ answer: context.answer ?? '' }),
      },
    },
  });

  const result = await runAgent(machine, {
    input: { question: 'why xstate agents?' },
    generateText: async (request) => `answer from ${request.prompt ?? ''}`,
  });

  assert.equal(result.status, 'done');
  assert.ok(
    result.status === 'done' && result.output.answer.includes('doc:typed state'),
  );
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  await runLangGraphRAGExample();
}
