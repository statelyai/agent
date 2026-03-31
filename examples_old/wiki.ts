import { z } from 'zod';
import { createAgent } from '../src';
import { openai } from '@ai-sdk/openai';
import { CoreMessage, generateText, streamText, tool } from 'ai';

const agent = createAgent({
  name: 'wiki',
  model: openai('gpt-4-turbo'),
  events: {
    provideAnswer: z.object({
      answer: z.string().describe('The answer'),
    }),
  },
});

agent.onMessage((msg) => {
  console.log(msg);
});

async function main() {
  await generateText({
    model: agent.model,
    prompt: 'When was Deadpool 2 released?',
  });

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
