import { z } from 'zod';
import { createAgentMachine } from '../src/index.js';
import {
  closePrompt,
  formatResult,
  generateExampleObject,
  isMain,
  prompt,
} from './_run.js';

const searchSchema = z.object({
  searchResults: z.array(z.string()),
});

const articleSchema = z.object({
  article: z.string(),
});

const critiqueSchema = z.object({
  critique: z.string().nullable(),
});

export function createNewspaperExample(
  options: {
    search?: (topic: string) => Promise<z.infer<typeof searchSchema>>;
    curate?: (topic: string, searchResults: string[]) => Promise<z.infer<typeof searchSchema>>;
    write?: (topic: string, searchResults: string[]) => Promise<z.infer<typeof articleSchema>>;
    critique?: (article: string, revisionCount: number) => Promise<z.infer<typeof critiqueSchema>>;
    revise?: (article: string, critique: string) => Promise<z.infer<typeof articleSchema>>;
    maxRevisions?: number;
  } = {}
) {
  const search =
    options.search ??
    ((topic: string) =>
      generateExampleObject({
        schema: searchSchema,
        system: 'You brainstorm plausible research leads for an article topic.',
        prompt: `List 3 to 5 concise research leads or search angles for an article about ${topic}.`,
      }));
  const curate =
    options.curate ??
    ((topic: string, searchResults: string[]) =>
      generateExampleObject({
        schema: searchSchema,
        system: 'You curate research inputs for a focused article.',
        prompt: [
          `Topic: ${topic}`,
          'Choose the best 2 or 3 research leads from the list below.',
          ...searchResults.map((result) => `- ${result}`),
        ].join('\n'),
      }));
  const write =
    options.write ??
    ((topic: string, searchResults: string[]) =>
      generateExampleObject({
        schema: articleSchema,
        system: 'You write short newspaper-style drafts in Markdown.',
        prompt: [
          `Topic: ${topic}`,
          'Write a short article draft using these research leads:',
          ...searchResults.map((result) => `- ${result}`),
        ].join('\n'),
      }));
  const critique =
    options.critique ??
    ((article: string, revisionCount: number) =>
      generateExampleObject({
        schema: critiqueSchema,
        system: 'You critique article drafts. Return null when no further revision is needed.',
        prompt: [
          `Revision count: ${revisionCount}`,
          'Review this article draft and either return one concise critique or null if it is ready.',
          '',
          article,
        ].join('\n'),
      }));
  const revise =
    options.revise ??
    ((article: string, notes: string) =>
      generateExampleObject({
        schema: articleSchema,
        system: 'You revise article drafts while preserving the main facts.',
        prompt: [
          'Revise the article to address this critique:',
          notes,
          '',
          article,
        ].join('\n'),
      }));

  return createAgentMachine({
    id: 'newspaper-example',
    schemas: {
      input: z.object({ topic: z.string() }),
      output: z.object({
        topic: z.string(),
        article: z.string().nullable(),
        revisionCount: z.number(),
        searchResults: z.array(z.string()),
      }),
    },
    context: (input) => ({
      topic: input.topic,
      searchResults: [] as string[],
      article: null as string | null,
      critique: null as string | null,
      revisionCount: 0,
      maxRevisions: options.maxRevisions ?? 2,
    }),
    initial: 'searching',
    states: {
      searching: {
        resultSchema: searchSchema,
        invoke: async ({ context }) => search(context.topic),
        onDone: ({ result }) => ({
          target: 'curating',
          context: { searchResults: result.searchResults },
        }),
      },
      curating: {
        resultSchema: searchSchema,
        invoke: async ({ context }) => curate(context.topic, context.searchResults),
        onDone: ({ result }) => ({
          target: 'writing',
          context: { searchResults: result.searchResults },
        }),
      },
      writing: {
        resultSchema: articleSchema,
        invoke: async ({ context }) => write(context.topic, context.searchResults),
        onDone: ({ result }) => ({
          target: 'critiquing',
          context: { article: result.article },
        }),
      },
      critiquing: {
        resultSchema: critiqueSchema,
        invoke: async ({ context }) =>
          critique(context.article ?? '', context.revisionCount),
        onDone: ({ result, context }) => ({
          target:
            !result.critique || context.revisionCount >= context.maxRevisions
              ? 'done'
              : 'revising',
          context: { critique: result.critique },
        }),
      },
      revising: {
        resultSchema: articleSchema,
        invoke: async ({ context }) =>
          revise(context.article ?? '', context.critique ?? ''),
        onDone: ({ result, context }) => ({
          target: 'critiquing',
          context: {
            article: result.article,
            revisionCount: context.revisionCount + 1,
          },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          topic: context.topic,
          article: context.article,
          revisionCount: context.revisionCount,
          searchResults: context.searchResults,
        }),
      },
    },
  });
}

async function main() {
  try {
    const topic = await prompt('Newspaper topic');
    const machine = createNewspaperExample();
    console.log(formatResult(await machine.execute(machine.getInitialState({ topic }))));
  } finally {
    closePrompt();
  }
}

if (isMain(import.meta.url)) {
  void main();
}
