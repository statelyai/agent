import { z } from 'zod';
import { createAgent } from '../src';
import { openai } from '@ai-sdk/openai';

const agent = createAgent({
  name: 'wiki',
  model: openai('gpt-4-turbo'),
  events: {
    provideAnswer: z.object({
      answer: z.string().describe('The answer'),
    }),
  },
});

async function main() {
  const response1 = await agent.generateText({
    prompt: 'When was Deadpool 2 released?',
  });

  console.log(response1.text);

  const response2 = await agent.generateText({
    messages: (x) => x.select((ctx) => ctx.messages),
    prompt: 'What about the first one?',
  });

  console.log(response2.text);
}

main();
