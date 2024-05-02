---
'@statelyai/agent': minor
---

The `createAgent(…)` function now returns **agent actor logic** instead of the state machine actor logic. That means its return value can now be used directly in `actors` for a state machine, and it will perform tool calls and choose the correct event to send back to the machine:

```ts
import { createAgent } from '../src';
import { z } from 'zod';
import { setup, createActor } from 'xstate';
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const agent = createAgent(openai, {
  model: 'gpt-3.5-turbo-16k-0613',
  events: {
    'agent.thought': z.object({
      text: z.string().describe('The text of the thought'),
    }),
  },
});

const machine = setup({
  actors: { agent },
}).createMachine({
  initial: 'thinking',
  states: {
    thinking: {
      invoke: {
        src: 'agent',
        input: 'Think about a random topic, and then share that thought.',
      },
      on: {
        'agent.thought': {
          actions: ({ event }) => console.log(event.text),
          target: 'thought',
        },
      },
    },
    thought: {
      type: 'final',
    },
  },
});

const actor = createActor(machine).start();
```

See the examples directory for more detailed examples
