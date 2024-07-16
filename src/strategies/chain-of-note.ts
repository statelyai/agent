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
  context: (x) => ({
    ...x.input,
    searchResults: null,
    summaries: null,
  }),
  states: {
    searching: {
      invoke: {
        src: 'searchWiki',
        input: (x) => ({
          query: x.context.prompt,
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
        input: (x) => ({
          searchResult: x.context.searchResults!,
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

// export function chainOfNote() {
//   return {
//     generateText: async (x) => {
//       const passages = await wiki.search(x.prompt!, {
//         limit: 5,
//       });

//       const extracts = await Promise.all(
//         passages.results.map(async (p) => {
//           const summary = await wiki.summary(p.title);
//           return summary.extract;
//         })
//       );
//       x.agent?.addMessage({
//         content: x.prompt!,
//         id: Date.now() + '',
//         role: 'user',
//         timestamp: Date.now(),
//       });
//       const result = await generateText({
//         model: x.model,
//         system: `Task Description:

// 1. Read the given question and five Wikipedia passages to gather relevant information.

// 2. Write reading notes summarizing the key points from these passages.

// 3. Discuss the relevance of the given question and Wikipedia passages.

// 4. If some passages are relevant to the given question, provide a brief answer based on the passages.

// 5. If no passage is relevant, direcly provide answer without considering the passages.

// Passages: \n${extracts.join('\n')}`,
//         prompt: `${x.prompt!}`,
//       });

//       x.agent?.addMessage({
//         content: result.text,
//         id: Date.now() + '',
//         role: 'user',
//         timestamp: Date.now(),
//       });

//       return result;
//     },
//   } satisfies AgentStrategy;
// }
