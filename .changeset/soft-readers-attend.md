---
'@statelyai/agent': patch
---

The `createSchemas(…)` function has been removed. The `defineEvents(…)` function should be used instead, as it is a simpler way of defining events and event schemas using Zod:

```ts
import { defineEvents } from '@statelyai/agent';
import { z } from 'zod';
import { setup } from 'xstate';

const events = defineEvents({
  inc: z.object({
    by: z.number().describe('Increment amount'),
  }),
});

const machine = setup({
  types: {
    events: events.types,
  },
  schema: {
    events: events.schemas,
  },
}).createMachine({
  // ...
});
```
