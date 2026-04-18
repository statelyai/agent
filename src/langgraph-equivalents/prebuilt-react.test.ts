import { expect, test } from 'vitest';
import {
  createMemoryRunStore,
  createReactAgent,
  startSession,
} from '../index.js';

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

test('prebuilt react agent loops through a tool call and returns a final answer', async () => {
  const agent = createReactAgent({
    prompt: 'You are helpful.',
    tools: [
      {
        name: 'search',
        description: 'Searches for a query',
        execute: async (input) => `result for ${String(input.query)}`,
      },
    ],
    model: async ({ messages }) => {
      const last = messages.at(-1);

      if (!last || last.role === 'user') {
        return {
          kind: 'tool' as const,
          toolName: 'search',
          input: { query: 'weather in sf' },
          message: 'I should search first.',
        };
      }

      if (last.role === 'tool') {
        return {
          kind: 'final' as const,
          message: `Answer based on: ${last.content}`,
        };
      }

      throw new Error('Unexpected transcript state');
    },
  });

  const run = await startSession(agent, {
    store: createMemoryRunStore(),
    input: {
      messages: [{ role: 'user', content: 'What is the weather?' }],
    },
  });
  const toolEvents: string[] = [];

  run.on('toolCall', (event) => {
    toolEvents.push(`call:${event.toolName}`);
  });
  run.on('toolResult', (event) => {
    toolEvents.push(`result:${event.toolName}`);
  });

  await once(run.onDone.bind(run));

  expect(toolEvents).toEqual(['call:search', 'result:search']);
  expect(run.getSnapshot()).toEqual(
    expect.objectContaining({
      value: 'done',
      status: 'done',
      output: {
        finalMessage: 'Answer based on: result for weather in sf',
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'What is the weather?' },
          { role: 'assistant', content: 'I should search first.' },
          { role: 'tool', name: 'search', content: 'result for weather in sf' },
          { role: 'assistant', content: 'Answer based on: result for weather in sf' },
        ],
        steps: 2,
      },
    })
  );
});
