import { z } from 'zod';
import { createMemoryRunStore, restoreSession, startSession, waitForRunDone, waitForRunSnapshot } from '../src/local/index.js';
import { createReactAgentFromScratch } from './react-agent-from-scratch.js';
import {
  closePrompt,
  generateExampleObject,
  generateExampleText,
  isMain,
  prompt,
} from './_run.js';

const reactModelResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('tool'),
    toolName: z.literal('search'),
    input: z.object({
      query: z.string(),
    }),
    message: z.string().optional(),
  }),
  z.object({
    kind: z.literal('final'),
    message: z.string(),
  }),
]);

export function createReactAgentExample(options: {
  search?: (query: string) => Promise<string>;
  model?: (args: {
    messages: Array<{
      role: 'system' | 'user' | 'assistant' | 'tool';
      content: string;
      name?: string;
    }>;
  }) => Promise<z.infer<typeof reactModelResultSchema>>;
} = {}) {
  return createReactAgentFromScratch({
    prompt: 'You are a helpful assistant.',
    tools: [
      {
        name: 'search',
        description: 'Searches the knowledge base.',
        execute: async (input) =>
          (options.search
            ?? ((query) =>
              generateExampleText({
                system: 'You are a concise search backend returning a short factual result snippet.',
                prompt: `Return a short search result snippet for the query: ${query}`,
              })))(String(input.query)),
      },
    ],
    model:
      options.model
      ?? (({ messages }) =>
        generateExampleObject({
          schema: reactModelResultSchema,
          system: [
            'You are a ReAct-style assistant.',
            'If you still need outside information, call the search tool.',
            'If the latest tool result is enough, answer directly with kind="final".',
          ].join('\n'),
          prompt: messages
            .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
            .join('\n'),
        })),
  });
}

async function main() {
  try {
    const message = await prompt('User');
    const agent = createReactAgentExample();
    const run = await startSession(agent, {
      store: createMemoryRunStore(),
      input: {
        messages: [{ role: 'user', content: message }],
      },
    });

    run.on('toolCall', (event) => {
      console.log(`Calling ${event.toolName}(${event.input.query})`);
    });
    run.on('toolResult', (event) => {
      console.log(`${event.toolName} -> ${String(event.output)}`);
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
