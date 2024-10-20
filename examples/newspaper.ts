// Based on GPT Newspaper:
// https://github.com/assafelovic/gpt-newspaper
// https://gist.github.com/TheGreatBonnie/58dc21ebbeeb8cbb08df665db762738c

import { tavily } from '@tavily/core';

import { assign, createActor, fromPromise, setup } from 'xstate';
import { createAgent } from '../src';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';
import { generateObject, generateText } from 'ai';

interface AgentState {
  topic: string;
  searchResults?: string;
  article?: string;
  critique?: string;
  revisionCount: number;
}

const agent = createAgent({
  model: openai('gpt-4o-mini'),
  events: {},
});

async function search({
  topic,
}: Pick<AgentState, 'topic'>): Promise<string | undefined> {
  const tvly = tavily({
    apiKey: process.env.TAVILY_API_KEY,
  });
  const response = await tvly.search(topic, {});

  return response.answer;
}

async function curate(
  input: Pick<AgentState, 'topic' | 'searchResults'>
): Promise<string> {
  const response = await generateObject({
    model: agent.model,
    system: `
You are a personal newspaper editor. 
Your sole task is to return a list of URLs of the 5 most relevant articles for the provided topic or query as a JSON list of strings.`.trim(),
    prompt: `Today's date is ${new Date().toLocaleDateString('en-GB')}
Topic or Query: ${input.topic}

Here is a list of articles:
${input.searchResults}`.trim(),
    schema: z.object({
      urls: z.array(z.string()).describe('The URLs of the articles'),
    }),
  });
  const urls = response.object.urls;
  const searchResults = JSON.parse(input.searchResults ?? '[]');
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
    feedbackInstructions = `
        The writer has revised the article based on your previous critique: ${input.critique}
        The writer might have left feedback for you encoded between <FEEDBACK> tags.
        The feedback is only for you to see and will be removed from the final article.
      `.trim();
  }

  const response = await generateObject({
    model: agent.model,
    system: `
  You are a personal newspaper writing critique. 
  Your sole purpose is to provide short feedback on a written article so the writer will know what to fix.
  Today's date is ${new Date().toLocaleDateString('en-GB')}
  Your task is to provide a really short feedback on the article only if necessary.
  If you think the article is good, please return [DONE].
  You can provide feedback on the revised article or just return [DONE] if you think the article is good.
  Please return a string of your critique or [DONE].`.trim(),
    prompt: `
  ${feedbackInstructions}
  This is the article: ${input.article}`.trim(),
    schema: z.object({
      critique: z
        .string()
        .describe(
          'The critique of the article or [DONE] if no changes are needed'
        ),
    }),
  });

  const content = response.object.critique;
  console.log('critique:', content);
  return content.includes('[DONE]') ? undefined : content;
}

async function write(
  input: Pick<AgentState, 'searchResults' | 'topic'>
): Promise<string> {
  const response = await generateObject({
    model: agent.model,
    system:
      `You are a personal newspaper writer. Your sole purpose is to write a well-written article about a 
        topic using a list of articles. Write 5 paragraphs in markdown.`.replace(
        /\s+/g,
        ' '
      ),
    prompt: `Today's date is ${new Date().toLocaleDateString('en-GB')}.
        Your task is to write a critically acclaimed article for me about the provided query or 
        topic based on the sources. 
        Here is a list of articles: ${input.searchResults}
        This is the topic: ${input.topic}
        Please return a well-written article based on the provided information.`.replace(
      /\s+/g,
      ' '
    ),
    schema: z.object({
      article: z
        .string()
        .describe('The well-written article based on the provided information'),
    }),
  });

  const content = response.object.article;
  return content;
}
async function revise(
  input: Pick<AgentState, 'article' | 'critique'>
): Promise<string> {
  const response = await generateObject({
    model: agent.model,
    system:
      `You are a personal newspaper editor. Your sole purpose is to edit a well-written article about a 
      topic based on given critique.`.replace(/\s+/g, ' '),
    prompt: `Your task is to edit the article based on the critique given.
      This is the article: ${input.article}
      This is the critique: ${input.critique}
      Please return the edited article based on the critique given.
      You may leave feedback about the critique encoded between <FEEDBACK> tags like this:
      <FEEDBACK> here goes the feedback ...</FEEDBACK>`.replace(/\s+/g, ' '),
    schema: z.object({
      article: z
        .string()
        .describe('The edited article based on the critique given'),
    }),
  });

  const content = response.object.article;
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
    topic: 'Orlando',
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

const actor = createActor(machine);

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
