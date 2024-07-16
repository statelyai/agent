---
'@statelyai/agent': minor
---

You can now add `context` Zod schema to your agent. For now, this is meant to be passed directly to the state machine, but in the future, the schema can be shared with the LLM agent to better understand the state machine and its context for decision making.

Breaking: The `context` and `events` types are now in `agent.types` instead of ~~`agent.eventTypes`.

```ts
const agent = createAgent({
  // ...
  context: {
    score: z.number().describe('The score of the game'),
    // ...
  },
});

const machine = setup({
  types: agent.types,
}).createMachine({
  context: {
    score: 0,
  },
  // ...
});
```
