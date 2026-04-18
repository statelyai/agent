import { expect, test } from 'vitest';
import { createMemoryRunStore, startSession } from '../index.js';
import { createSqlAgentExample } from '../../examples/sql-agent.js';

function once<T = unknown>(
  subscribe: (handler: (event: T) => void) => () => void
) {
  return new Promise<T>((resolve) => {
    let off = () => {};
    off = subscribe((event) => {
      off();
      resolve(event);
    });
  });
}

test('sql-agent workflow retries after a bad query and answers once rows are available', async () => {
  let decisions = 0;

  const machine = createSqlAgentExample({
    adapter: {
      decide: async () => {
        decisions += 1;

        if (decisions === 1) {
          return {
            choice: 'query',
            data: {
              query: 'SELECT total FROM invoices WHERE customer = "Acme"',
            },
          };
        }

        if (decisions === 2) {
          return {
            choice: 'query',
            data: {
              query: 'SELECT customer, total FROM invoices WHERE customer = \'Acme\'',
            },
          };
        }

        return {
          choice: 'answer',
          data: {
            answer: 'Acme has one invoice total of 42.',
          },
        };
      },
    },
    executeQuery: async ({ query }) => {
      if (query.includes('"Acme"')) {
        return {
          status: 'error' as const,
          error: 'SQL syntax error near double quotes.',
        };
      }

      return {
        status: 'success' as const,
        rows: [{ customer: 'Acme', total: 42 }],
      };
    },
  });

  const run = await startSession(machine, {
    store: createMemoryRunStore(),
    input: {
      question: 'What is Acme owed?',
      schema: 'invoices(customer text, total integer)',
    },
  });
  const events: string[] = [];

  run.on('toolCall', (event) => {
    events.push(`call:${event.input.query}`);
  });
  run.on('toolResult', (event) => {
    events.push(`result:${event.output.status}`);
  });

  await once(run.onDone.bind(run));

  expect(events).toEqual([
    'call:SELECT total FROM invoices WHERE customer = "Acme"',
    'result:error',
    "call:SELECT customer, total FROM invoices WHERE customer = 'Acme'",
    'result:success',
  ]);
  expect(run.getSnapshot()).toEqual(
    expect.objectContaining({
      value: 'done',
      status: 'done',
      output: {
        question: 'What is Acme owed?',
        schema: 'invoices(customer text, total integer)',
        answer: 'Acme has one invoice total of 42.',
        latestRows: [{ customer: 'Acme', total: 42 }],
        latestError: null,
        queryHistory: [
          'SELECT total FROM invoices WHERE customer = "Acme"',
          "SELECT customer, total FROM invoices WHERE customer = 'Acme'",
        ],
      },
    })
  );
});
