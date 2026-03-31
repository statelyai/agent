import { z } from 'zod';
import { createAgent } from '../src';
import { openai } from '@ai-sdk/openai';
import { createMachine } from 'xstate';

const agent = createAgent({
  model: openai('gpt-4o'),
  events: {
    doSomething: z.object({}).describe('Do something'),
  },
});

async function main() {
  const machine = createMachine({
    on: {
      doSomething: {},
    },
  });
  const result = await agent.decide({
    goal: 'Do not do anything',
    state: { value: {}, context: {} },
    machine,
  });

  console.log(result);
}

main();
