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

  console.log(agent.getSnapshot());

  const history = await agent.getHistory();

  const res2 = await agent.generateText({
    prompt: history!
      .map((h) => h.content)
      .concat('What about the first one?')
      .join('\n\n'),
  });

  console.log(res2.text);
}

main();
