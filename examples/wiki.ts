import { z } from 'zod';
import { createAgent } from '../src';
import { openai } from '@ai-sdk/openai';
import { chainOfNote } from '../src/templates/chain-of-note';

const agent = createAgent({
  model: openai('gpt-4-turbo'),
  events: {
    provideAnswer: z.object({
      answer: z.string().describe('The answer'),
    }),
  },
});

async function main() {
  const template = chainOfNote();

  const res = await template.generateText({
    model: openai('gpt-4-turbo'),
    prompt: 'When was Deadpool 2 released?',
  });

  console.log(res.text);
}

main();
