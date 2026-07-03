/**
 * Burr Conversational RAG — retrieval + memory as explicit machine context.
 *
 * Burr's `conversational-rag` example threads chat history and retrieved
 * documents through its application state between actions. Here that's
 * plain XState context: `retrieve` is a typed host actor, `memory`
 * accumulates in context across turns, and `answerWithDocuments` is a
 * co-located request — hosted with `runAgent` instead of manual
 * `createActor`/`toPromise` choreography.
 */
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createAsyncLogic } from 'xstate';
import { runAgent, setupAgent, type AgentTextRequest, type AgentTools } from '../../src/index.js';

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

  const generateText = async (request: AgentTextRequest & { tools: AgentTools }) => {
    const lines = (request.prompt ?? '').split('\n');
    const memoryCount = lines[1]!.replace('Memory: ', '').split(' | ').filter(Boolean).length;
    const documents = lines[2]!.replace('Docs: ', '').split(' | ').join(',');
    return `answer:${documents}:memory=${memoryCount}`;
  };

  const result = await runAgent(machine, {
    input: { question: 'why burr?', memory: ['prior turn'] },
    generateText,
  });

  if (result.status !== 'done') {
    throw new Error(`Conversational RAG example did not complete: ${result.status}`);
  }
  assert.deepEqual(result.output, {
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
