import { z } from 'zod';
import {
  createMemoryRunStore,
  createReactAgent,
  startSession,
} from '../src/index.js';
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
  return createReactAgent({
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
      const call = event as { toolName: string; input: { query: string } };
      console.log(`Calling ${call.toolName}(${call.input.query})`);
    });
    run.on('toolResult', (event) => {
      const result = event as {
        toolName: string;
        output: unknown;
      };
      console.log(`${result.toolName} -> ${String(result.output)}`);
    });

    await new Promise<void>((resolve, reject) => {
      run.on('done', (event) => {
        console.log((event as { output: unknown }).output);
        resolve();
      });
      run.on('error', (event) => {
        reject((event as { error: unknown }).error);
      });
    });
  } finally {
    closePrompt();
  }
}

if (isMain(import.meta.url)) {
  void main();
}
