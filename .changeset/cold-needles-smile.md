---
'@statelyai/agent': minor
---

The `createAgent(…)` function now returns **agent actor logic** instead of the state machine actor logic. That means its return value can now be used directly in `actors` for a state machine, and it will perform tool calls and choose the correct event to send back to the machine:

```ts
import { createAgent } from '@statelyai/agent';
import { z } from 'zod';
import { setup, createAcotr } from 'xstate';

const agent = createAgent({
  model: 'gpt-4-1106-preview',
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
        input: 'Produce a random thought',
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
