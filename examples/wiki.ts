import { z } from 'zod';
import { createAgent } from '../src';
import { openai } from '@ai-sdk/openai';
import { CoreMessage, generateText, streamText } from 'ai';

const agent = createAgent({
  name: 'wiki',
  model: openai('gpt-4o-mini'),
  events: {
    provideAnswer: z.object({
      answer: z.string().describe('The answer'),
    }),
    researchTopic: z.object({
      topic: z.string().describe('The topic to research'),
    }),
  },
});

agent.onMessage((msg) => {
  console.log(msg);
});

async function main() {
  const response = await generateText({
    model: agent.model,
    prompt: 'When was Deadpool 2 released?',
  });

  for (const msg of await response.responseMessages) {
    agent.addMessage(msg);
  }

  const response2 = await streamText({
    model: agent.model,
    messages: (agent.getMessages() as CoreMessage[]).concat({
      role: 'user',
      content: 'What about the first one?',
    }),
  });

  let text = '';

  for await (const t of response2.textStream) {
    text += t;
    console.log(text);
  }
}

main();
