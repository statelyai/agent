import { TavilySearchAPIRetriever } from '@langchain/community/retrievers/tavily_search_api';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { assign, createActor, fromPromise, setup } from 'xstate';

interface AgentState {
  topic: string;
  searchResults?: string;
  article?: string;
  critique?: string;
  revisionCount: number;
}

function model() {
  return new ChatOpenAI({
    temperature: 0,
    modelName: 'gpt-4-1106-preview',
    openAIApiKey: process.env.OPENAI_API_KEY,
  });
}

async function search({ topic }: Pick<AgentState, 'topic'>): Promise<string> {
  const retriever = new TavilySearchAPIRetriever({
    k: 10,
    apiKey: process.env.TAVILY_API_KEY,
  });
  // let topic = state.agentState.topic;
  // must be at least 5 characters long
  if (topic.length < 5) {
    topic = 'topic: ' + topic;
  }
  const docs = await retriever.getRelevantDocuments(topic);
  return JSON.stringify(docs);
}

async function curate(
  input: Pick<AgentState, 'topic' | 'searchResults'>
): Promise<string> {
  const response = await model().invoke(
    [
      new SystemMessage(
        `You are a personal newspaper editor. 
         Your sole task is to return a list of URLs of the 5 most relevant articles for the provided topic or query as a JSON list of strings
         in this format:
         {
          urls: ["url1", "url2", "url3", "url4", "url5"]
         }
         .`.replace(/\s+/g, ' ')
      ),
      new HumanMessage(
        `Today's date is ${new Date().toLocaleDateString('en-GB')}.
       Topic or Query: ${input.topic}
       
       Here is a list of articles:
       ${input.searchResults}`.replace(/\s+/g, ' ')
      ),
    ],
    {
      response_format: {
        type: 'json_object',
      },
    }
  );
  const urls = JSON.parse(response.content as string).urls;
  const searchResults = JSON.parse(input.searchResults!);
  const newSearchResults = searchResults.filter((result: any) => {
    return urls.includes(result.metadata.source);
  });
  return JSON.stringify(newSearchResults);
}

async function critique(
  input: Pick<AgentState, 'article' | 'critique'>
): Promise<string | undefined> {
  let feedbackInstructions = '';
  if (input.critique) {
    feedbackInstructions =
      `The writer has revised the article based on your previous critique: ${input.critique}
       The writer might have left feedback for you encoded between <FEEDBACK> tags.
       The feedback is only for you to see and will be removed from the final article.
    `.replace(/\s+/g, ' ');
  }
  const response = await model().invoke([
    new SystemMessage(
      `You are a personal newspaper writing critique. Your sole purpose is to provide short feedback on a written 
      article so the writer will know what to fix.       
      Today's date is ${new Date().toLocaleDateString('en-GB')}
      Your task is to provide a really short feedback on the article only if necessary.
      if you think the article is good, please return [DONE].
      you can provide feedback on the revised article or just
      return [DONE] if you think the article is good.
      Please return a string of your critique or [DONE].`.replace(/\s+/g, ' ')
    ),
    new HumanMessage(
      `${feedbackInstructions}
       This is the article: ${input.article}`
    ),
  ]);
  const content = response.content as string;
  console.log('critique:', content);
  return content.includes('[DONE]') ? undefined : content;
}

async function write(
  input: Pick<AgentState, 'searchResults' | 'topic'>
): Promise<string> {
  const response = await model().invoke([
    new SystemMessage(
      `You are a personal newspaper writer. Your sole purpose is to write a well-written article about a 
      topic using a list of articles. Write 5 paragraphs in markdown.`.replace(
        /\s+/g,
        ' '
      )
    ),
    new HumanMessage(
      `Today's date is ${new Date().toLocaleDateString('en-GB')}.
      Your task is to write a critically acclaimed article for me about the provided query or 
      topic based on the sources. 
      Here is a list of articles: ${input.searchResults}
      This is the topic: ${input.topic}
      Please return a well-written article based on the provided information.`.replace(
        /\s+/g,
        ' '
      )
    ),
  ]);
  const content = response.content as string;
  return content;
}

async function revise(
  input: Pick<AgentState, 'article' | 'critique'>
): Promise<string> {
  const response = await model().invoke([
    new SystemMessage(
      `You are a personal newspaper editor. Your sole purpose is to edit a well-written article about a 
      topic based on given critique.`.replace(/\s+/g, ' ')
    ),
    new HumanMessage(
      `Your task is to edit the article based on the critique given.
      This is the article: ${input.article}
      This is the critique: ${input.critique}
      Please return the edited article based on the critique given.
      You may leave feedback about the critique encoded between <FEEDBACK> tags like this:
      <FEEDBACK> here goes the feedback ...</FEEDBACK>`.replace(/\s+/g, ' ')
    ),
  ]);
  const content = response.content as string;
  return content;
}

const machine = setup({
  types: {
    context: {} as AgentState,
  },
  actors: {
    search: fromPromise(({ input }: { input: Pick<AgentState, 'topic'> }) => {
      return search(input);
    }),
    curate: fromPromise(
      ({ input }: { input: Pick<AgentState, 'topic' | 'searchResults'> }) => {
        return curate(input);
      }
    ),
    critique: fromPromise(
      ({ input }: { input: Pick<AgentState, 'article' | 'critique'> }) => {
        return critique(input);
      }
    ),
    write: fromPromise(
      ({ input }: { input: Pick<AgentState, 'searchResults' | 'topic'> }) => {
        return write(input);
      }
    ),
    revise: fromPromise(
      ({ input }: { input: Pick<AgentState, 'article' | 'critique'> }) => {
        return revise(input);
      }
    ),
  },
}).createMachine({
  context: {
    topic: 'donuts',
    revisionCount: 0,
  },
  initial: 'search',
  states: {
    search: {
      invoke: {
        src: 'search',
        input: ({ context }) => ({
          topic: context.topic,
        }),
        onDone: {
          actions: assign({
            searchResults: ({ event }) => event.output,
          }),
          target: 'curate',
        },
      },
    },
    curate: {
      invoke: {
        src: 'curate',
        input: ({ context }) => ({
          topic: context.topic,
          searchResults: context.searchResults!,
        }),
        onDone: {
          actions: assign({
            searchResults: ({ event }) => event.output,
          }),
          target: 'write',
        },
      },
    },
    write: {
      invoke: {
        src: 'write',
        input: ({ context }) => ({
          topic: context.topic,
          searchResults: context.searchResults!,
        }),
        onDone: {
          actions: assign({
            article: ({ event }) => event.output,
          }),
          target: 'critique',
        },
      },
    },
    critique: {
      invoke: {
        src: 'critique',
        input: ({ context }) => ({
          article: context.article!,
          critique: context.critique,
        }),
        onDone: [
          {
            guard: ({ event }) => event.output === undefined,
            target: 'done',
          },
          {
            actions: assign({
              article: ({ event }) => event.output,
            }),
            target: 'revise',
          },
        ],
      },
    },
    revise: {
      always: {
        guard: ({ context }) => context.revisionCount > 3,
        target: 'done',
      },
      entry: assign({
        revisionCount: ({ context }) => context.revisionCount + 1,
      }),
      invoke: {
        src: 'revise',
        input: ({ context }) => ({
          article: context.article!,
          critique: context.critique,
        }),
        onDone: {
          actions: assign({
            article: ({ event }) => event.output,
          }),
          target: 'revise',
          reenter: true,
        },
      },
    },
    done: {
      type: 'final',
    },
  },
  output: ({ context }) => context.article,
});

const actor = createActor(machine, {
  // inspect: (inspEv) => {
  //   if (inspEv.type === '@xstate.event') {
  //     console.log(JSON.stringify(inspEv.event, null, 2));
  //   }
  // },
});

actor.subscribe({
  next: (s) => {
    console.log('State:', s.value);
    console.log(
      'Context:',
      JSON.stringify(
        s.context,
        (k, v) => {
          if (typeof v === 'string') {
            // truncate if longer than 50 chars
            return v.length > 50 ? `${v.slice(0, 50)}...` : v;
          }
          return v;
        },
        2
      )
    );
  },
  complete: () => {
    console.log(actor.getSnapshot().output);
  },
  error: (err) => {
    console.error(err);
  },
});

actor.start();

// keep the process alive by invoking a promise that never resolves
new Promise(() => {});
