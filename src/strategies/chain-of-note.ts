import { GenerateTextResult, LanguageModel } from 'ai';
import wiki, { wikiSearchResult, wikiSummary } from 'wikipedia';
import { assign, fromPromise, setup } from 'xstate';
import { AnyAgent } from '../types';

const searchWiki = fromPromise(
  async ({
    input,
  }: {
    input: {
      query: string;
      limit?: number;
    };
  }) => {
    const passages = await wiki.search(input.query, {
      limit: input.limit ?? 5,
    });
    return passages;
  }
);

const extractSummaries = fromPromise(
  async ({
    input,
  }: {
    input: {
      searchResult: wikiSearchResult;
    };
  }) => {
    const summaries = await Promise.all(
      input.searchResult.results.map(async (result) => {
        const summary = await wiki.summary(result.title);
        return {
          title: result.title,
          summary,
        };
      })
    );
    return summaries;
  }
);

export const chainOfNote = setup({
  types: {
    input: {} as {
      model: LanguageModel;
      agent: AnyAgent;
      prompt: string;
    },
    context: {} as {
      searchResults: wikiSearchResult | null;
      summaries:
        | {
            title: any;
            summary: wikiSummary;
          }[]
        | null;
      model: LanguageModel;
      agent: AnyAgent;
      prompt: string;
    },
    output: {} as GenerateTextResult<any>,
  },
  actors: {
    searchWiki,
    extractSummaries,
  },
}).createMachine({
  initial: 'searching',
  context: ({ input }) => ({
    ...input,
    searchResults: null,
    summaries: null,
  }),
  states: {
    searching: {
      invoke: {
        src: 'searchWiki',
        input: ({ context }) => ({
          query: context.prompt,
        }),
        onDone: {
          actions: assign({
            searchResults: ({ event }) => event.output,
          }),
          target: 'extracting',
        },
      },
    },
    extracting: {
      invoke: {
        src: 'extractSummaries',
        input: ({ context }) => ({
          searchResult: context.searchResults!,
        }),
        onDone: {
          actions: assign({
            summaries: ({ event }) => event.output,
          }),
          target: 'generating',
        },
      },
    },
    generating: {},
  },
});
