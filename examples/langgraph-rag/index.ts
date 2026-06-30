import assert from 'node:assert/strict';
import { z } from 'zod';
import { createActor, createAsyncLogic, toPromise, waitFor } from 'xstate';
import { setupAgent } from '../../src/index.js';

export async function runLangGraphRAGExample() {
  const agent = setupAgent({
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

  const actor = createActor(
    machine.provide({
      actorSources: {
        answerQuestion: agent.requests.answerQuestion.withExecutor(
          async ({ input }) =>
            `answer from Q: ${input.question}\nDocs:\n${input.documents.join('\n')}`,
        ),
      },
    }),
    { input: { question: 'why xstate agents?' } },
  );
  actor.start();
  await toPromise(actor);

  assert.ok(
    actor.getSnapshot().output?.answer.includes('doc:typed state'),
  );
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  await runLangGraphRAGExample();
}
