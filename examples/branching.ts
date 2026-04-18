import { z } from 'zod';
import { createAgentMachine } from '../src/index.js';
import {
  closePrompt,
  formatResult,
  generateExampleObject,
  generateExampleText,
  isMain,
  prompt,
} from './_run.js';

const branchResultSchema = z.object({
  docs: z.string(),
  issues: z.string(),
  code: z.string(),
});

const summarySchema = z.object({
  summary: z.string(),
});

export function createBranchingExample(
  options: {
    analyzeDocs?: (topic: string) => Promise<string>;
    analyzeIssues?: (topic: string) => Promise<string>;
    analyzeCode?: (topic: string) => Promise<string>;
    summarize?: (parts: {
      docs: string;
      issues: string;
      code: string;
    }) => Promise<z.infer<typeof summarySchema>>;
  } = {}
) {
  return createAgentMachine({
    id: 'branching-example',
    schemas: {
      input: z.object({ topic: z.string() }),
      output: z.object({
        docs: z.string().nullable(),
        issues: z.string().nullable(),
        code: z.string().nullable(),
        summary: z.string().nullable(),
      }),
    },
    context: (input) => ({
      topic: input.topic,
      docs: null as string | null,
      issues: null as string | null,
      code: null as string | null,
      summary: null as string | null,
    }),
    initial: 'analyzing',
    states: {
      analyzing: {
        resultSchema: branchResultSchema,
        invoke: async ({ context }) => {
          const [docs, issues, code] = await Promise.all([
            (options.analyzeDocs
              ?? ((topic) =>
                generateExampleText({
                  system: 'You are a repository docs analyst. Be concise and concrete.',
                  prompt: `Summarize what the documentation angle should cover for this topic in 2 short sentences:\n\n${topic}`,
                })))(context.topic),
            (options.analyzeIssues
              ?? ((topic) =>
                generateExampleText({
                  system: 'You analyze likely issue patterns and risks. Be concise and concrete.',
                  prompt: `Summarize the likely issue and operational concerns for this topic in 2 short sentences:\n\n${topic}`,
                })))(context.topic),
            (options.analyzeCode
              ?? ((topic) =>
                generateExampleText({
                  system: 'You analyze code-level implementation concerns. Be concise and concrete.',
                  prompt: `Summarize the likely code architecture and implementation concerns for this topic in 2 short sentences:\n\n${topic}`,
                })))(context.topic),
          ]);

          return { docs, issues, code };
        },
        onDone: ({ result }) => ({
          target: 'summarizing',
          context: result,
        }),
      },
      summarizing: {
        resultSchema: summarySchema,
        invoke: async ({ context }) =>
          (options.summarize
            ?? (({ docs, issues, code }) =>
              generateExampleObject({
                schema: summarySchema,
                system: 'You synthesize technical analysis into a concise summary.',
                prompt: [
                  'Combine these three perspectives into a concise high-level summary.',
                  '',
                  `Docs:\n${docs}`,
                  '',
                  `Issues:\n${issues}`,
                  '',
                  `Code:\n${code}`,
                ].join('\n'),
              })))({
            docs: context.docs ?? '',
            issues: context.issues ?? '',
            code: context.code ?? '',
          }),
        onDone: ({ result }) => ({
          target: 'done',
          context: { summary: result.summary },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          docs: context.docs,
          issues: context.issues,
          code: context.code,
          summary: context.summary,
        }),
      },
    },
  });
}

async function main() {
  try {
    const topic = await prompt('Topic');
    const machine = createBranchingExample();
    const result = await machine.execute(machine.getInitialState({ topic }));
    console.log(formatResult(result));
  } finally {
    closePrompt();
  }
}

if (isMain(import.meta.url)) {
  void main();
}
