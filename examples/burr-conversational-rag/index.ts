import assert from 'node:assert/strict';
import { z } from 'zod';
import { createActor, createAsyncLogic, toPromise, waitFor } from 'xstate';
import { setupAgent } from '../../src/index.js';

export async function runBurrConversationalRAGExample() {
  const agent = setupAgent({
    context: z.object({
      question: z.string(),
      memory: z.array(z.string()),
      documents: z.array(z.string()),
      answer: z.string().nullable(),
    }),
    input: z.object({
      question: z.string(),
      memory: z.array(z.string()).default([]),
    }),
    output: z.object({ answer: z.string(), memory: z.array(z.string()) }),
    actors: {
      retrieve: createAsyncLogic<string[], { question: string }>({
        run: async ({ input }) => [
          `doc:${input.question}`,
          'doc:remembered-state',
        ],
      }),
    },
    requests: {
      answerWithDocuments: {
        schemas: {
          input: z.object({
            question: z.string(),
            documents: z.array(z.string()),
            memory: z.array(z.string()),
          }),
          output: z.string(),
        },
        model: 'rag-answerer',
        prompt: ({ input }) =>
          [
            `Q: ${input.question}`,
            `Memory: ${input.memory.join(' | ')}`,
            `Docs: ${input.documents.join(' | ')}`,
          ].join('\n'),
      },
    },
  });

  const machine = agent.createMachine({
    id: 'burr-conversational-rag-xstate',
    context: ({ input }) => ({
      question: input.question,
      memory: input.memory,
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
          src: 'answerWithDocuments',
          input: ({ context }) => ({
            question: context.question,
            documents: context.documents,
            memory: context.memory,
          }),
          onDone: ({ context, output }) => ({
            target: 'done',
            context: {
              answer: output,
              memory: [
                ...context.memory,
                context.question,
                output,
              ],
            },
          }),
        },
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          answer: context.answer ?? '',
          memory: context.memory,
        }),
      },
    },
  });

  const actor = createActor(
    machine.provide({
      actorSources: {
        answerWithDocuments: agent.requests.answerWithDocuments.withExecutor(
          async ({ input }) =>
            `answer:${input.documents.join(',')}:memory=${input.memory.length}`,
        ),
      },
    }),
    { input: { question: 'why burr?', memory: ['prior turn'] } },
  );
  actor.start();
  await toPromise(actor);

  assert.deepEqual(actor.getSnapshot().output, {
    answer: 'answer:doc:why burr?,doc:remembered-state:memory=1',
    memory: [
      'prior turn',
      'why burr?',
      'answer:doc:why burr?,doc:remembered-state:memory=1',
    ],
  });
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  await runBurrConversationalRAGExample();
}
