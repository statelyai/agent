import { z } from 'zod';
import { createMemoryRunStore, restoreSession, startSession, waitForRunDone, waitForRunSnapshot } from '../src/local/index.js';
import {
  createAgentMachine,
  decide,
  decideResultSchema,
  type DecideAdapter,
} from '../src/index.js';
import {
  closePrompt,
  createOpenAiDecisionAdapter,
  generateExampleObject,
  isMain,
  prompt,
} from './_run.js';

const sqlValueSchema = z.union([z.string(), z.number(), z.null()]);
const sqlRowsSchema = z.array(z.record(z.string(), sqlValueSchema));

const planningOptions = {
  query: {
    description: 'Write or revise a SQL query that should help answer the question.',
    schema: z.object({
      query: z.string(),
    }),
  },
  answer: {
    description: 'Return the final answer once the available query results are sufficient.',
    schema: z.object({
      answer: z.string(),
    }),
  },
} as const;

const queryExecutionSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('success'),
    query: z.string(),
    rows: sqlRowsSchema,
  }),
  z.object({
    status: z.literal('error'),
    query: z.string(),
    error: z.string(),
  }),
]);

export function createSqlAgentExample(
  options: {
    adapter?: DecideAdapter;
    executeQuery?: (args: {
      question: string;
      schema: string;
      query: string;
      queryHistory: string[];
    }) => Promise<
      | { status: 'success'; rows: z.infer<typeof sqlRowsSchema> }
      | { status: 'error'; error: string }
    >;
  } = {}
) {
  const adapter = options.adapter ?? createOpenAiDecisionAdapter();
  const executeQuery =
    options.executeQuery ??
    ((args: {
      question: string;
      schema: string;
      query: string;
      queryHistory: string[];
    }) =>
      generateExampleObject({
        schema: z.discriminatedUnion('status', [
          z.object({
            status: z.literal('success'),
            rows: sqlRowsSchema,
          }),
          z.object({
            status: z.literal('error'),
            error: z.string(),
          }),
        ]),
        system: [
          'You simulate a SQL database tool for demos.',
          'Return status="success" with concise rows when the query is plausible.',
          'Return status="error" with a short SQL/tool error when the query is invalid.',
        ].join('\n'),
        prompt: [
          `Question: ${args.question}`,
          `Schema: ${args.schema}`,
          `Query: ${args.query}`,
          args.queryHistory.length
            ? `Prior queries:\n${args.queryHistory.map((query, index) => `${index + 1}. ${query}`).join('\n')}`
            : 'Prior queries: none',
        ].join('\n'),
      }));

  return createAgentMachine({
    id: 'sql-agent-example',
    schemas: {
      input: z.object({
        question: z.string(),
        schema: z.string(),
      }),
      emitted: {
        toolCall: z.object({
          toolName: z.literal('sqlDb'),
          input: z.object({
            query: z.string(),
          }),
        }),
        toolResult: z.object({
          toolName: z.literal('sqlDb'),
          output: queryExecutionSchema,
        }),
      },
      output: z.object({
        question: z.string(),
        schema: z.string(),
        answer: z.string().nullable(),
        latestRows: sqlRowsSchema.nullable(),
        latestError: z.string().nullable(),
        queryHistory: z.array(z.string()),
      }),
    },
    context: (input) => ({
      question: input.question,
      schema: input.schema,
      answer: null as string | null,
      latestRows: null as z.infer<typeof sqlRowsSchema> | null,
      latestError: null as string | null,
      queryHistory: [] as string[],
    }),
    initial: 'planning',
    states: {
      planning: {
        schemas: { output: decideResultSchema(planningOptions) },
        invoke: async ({ context }) =>
          decide({
            adapter,
            model: 'openai/gpt-5.4-nano',
            prompt: [
              'You are a SQL agent deciding whether to query the database again or answer.',
              'Query when you still need database evidence or when the last query failed.',
              'Answer only when the current rows are enough to respond directly.',
              '',
              `Question: ${context.question}`,
              `Schema: ${context.schema}`,
              context.queryHistory.length
                ? `Previous queries:\n${context.queryHistory.map((query, index) => `${index + 1}. ${query}`).join('\n')}`
                : 'Previous queries: none',
              context.latestError
                ? `Latest error: ${context.latestError}`
                : 'Latest error: none',
              context.latestRows
                ? `Latest rows:\n${JSON.stringify(context.latestRows, null, 2)}`
                : 'Latest rows: none',
            ].join('\n'),
            options: planningOptions,
          }),
        onDone: ({ output }) => {
          if (output.choice === 'query') {
            return {
              target: 'querying',
              input: {
                query: output.data.query,
              },
            };
          }

          return {
            target: 'done',
            context: {
              answer: output.data.answer,
            },
          };
        },
      },
      querying: {
        schemas: { input: z.object({
          query: z.string(),
        }), output: queryExecutionSchema },
        invoke: async ({ context, input }, enq) => {
          enq.emit({
            type: 'toolCall',
            toolName: 'sqlDb',
            input,
          });

          const output = await executeQuery({
            question: context.question,
            schema: context.schema,
            query: input.query,
            queryHistory: context.queryHistory,
          });

          const resolvedOutput =
            output.status === 'success'
              ? {
                  status: 'success' as const,
                  query: input.query,
                  rows: output.rows,
                }
              : {
                  status: 'error' as const,
                  query: input.query,
                  error: output.error,
                };

          enq.emit({
            type: 'toolResult',
            toolName: 'sqlDb',
            output: resolvedOutput,
          });

          return resolvedOutput;
        },
        onDone: ({ output, context }) => ({
          target: 'planning',
          context: {
            queryHistory: [
              ...context.queryHistory,
              output.query,
            ],
            latestRows: output.status === 'success' ? output.rows : null,
            latestError: output.status === 'error' ? output.error : null,
          },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          question: context.question,
          schema: context.schema,
          answer: context.answer,
          latestRows: context.latestRows,
          latestError: context.latestError,
          queryHistory: context.queryHistory,
        }),
      },
    },
  });
}

async function main() {
  try {
    const question = await prompt('Question');
    const schema = await prompt('Schema');
    const machine = createSqlAgentExample();
    const run = await startSession(machine, {
      store: createMemoryRunStore(),
      input: { question, schema },
    });

    run.on('toolCall', (event) => {
      console.log(`Calling ${event.toolName}(${event.input.query})`);
    });
    run.on('toolResult', (event) => {
      console.log(`${event.toolName} -> ${JSON.stringify(event.output)}`);
    });

    const done = await waitForRunDone(run);
    console.log(done.output);
  } finally {
    closePrompt();
  }
}

if (isMain(import.meta.url)) {
  void main();
}
