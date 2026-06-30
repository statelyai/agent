import assert from 'node:assert/strict';
import { z } from 'zod';
import { createActor, createAsyncLogic, toPromise, waitFor } from 'xstate';
import { setupAgent } from '../../src/index.js';

export async function runLangGraphSQLAgentExample() {
  const querySchema = z.object({ sql: z.string() });
  const agent = setupAgent({
    context: z.object({
      question: z.string(),
      sql: z.string().nullable(),
      rows: z.array(z.record(z.string(), z.string())),
      answer: z.string().nullable(),
    }),
    input: z.object({ question: z.string() }),
    output: z.object({ sql: z.string(), answer: z.string() }),
    actors: {
      queryDatabase: createAsyncLogic<
        Array<Record<string, string>>,
        { sql: string }
      >({
        run: async ({ input }) => [{ total: '42', sql: input.sql }],
      }),
    },
    requests: {
      writeQuery: {
        schemas: {
          input: z.object({ question: z.string() }),
          output: querySchema,
        },
        model: 'sql-writer',
        prompt: ({ input }) => input.question,
      },
      answerRows: {
        schemas: {
          input: z.object({
            rows: z.array(z.record(z.string(), z.string())),
          }),
          output: z.string(),
        },
        model: 'answerer',
        prompt: ({ input }) => JSON.stringify(input.rows),
      },
    },
  });

  const machine = agent.createMachine({
    id: 'raw-xstate-sql-agent',
    context: ({ input }) => ({
      question: input.question,
      sql: null,
      rows: [],
      answer: null,
    }),
    initial: 'writingQuery',
    states: {
      writingQuery: {
        invoke: {
          src: 'writeQuery',
          input: ({ context }) => ({ question: context.question }),
          onDone: ({ output }) => ({
            target: 'querying',
            context: { sql: output.sql },
          }),
        },
      },
      querying: {
        invoke: {
          src: 'queryDatabase',
          input: ({ context }) => ({ sql: context.sql ?? '' }),
          onDone: ({ output }) => ({
            target: 'answering',
            context: { rows: output },
          }),
        },
      },
      answering: {
        invoke: {
          src: 'answerRows',
          input: ({ context }) => ({ rows: context.rows }),
          onDone: ({ output }) => ({
            target: 'done',
            context: { answer: output },
          }),
        },
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          sql: context.sql ?? '',
          answer: context.answer ?? '',
        }),
      },
    },
  });

  const actor = createActor(
    machine.provide({
      actorSources: {
        writeQuery: agent.requests.writeQuery.withExecutor(async () => ({
          sql: 'select count(*) as total from users',
        })),
        answerRows: agent.requests.answerRows.withExecutor(
          async ({ input }) => `final:${JSON.stringify(input.rows)}`,
        ),
      },
    }),
    { input: { question: 'how many users?' } },
  );
  actor.start();
  await toPromise(actor);

  assert.deepEqual(actor.getSnapshot().output, {
    sql: 'select count(*) as total from users',
    answer:
      'final:[{"total":"42","sql":"select count(*) as total from users"}]',
  });
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  await runLangGraphSQLAgentExample();
}
