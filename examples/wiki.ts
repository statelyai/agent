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
  const res = await agent.generateText({
    prompt: 'When was Deadpool 2 released?',
  });

  console.log(res.text);

  await new Promise((res) => {
    setTimeout(() => {
      res({});
    }, 2000);
  });

  const res2 = await agent.generateText({
    messages: true,
    prompt: 'What about the first one?',
  });

  console.log(res2.text);
}

main();
