---
'@statelyai/agent': minor
---

Correlation IDs are now provided as part of the result from `agent.generateText(…)` and `agent.streamText(…)`:

```ts
const result = await agent.generateText({
  prompt: 'Write me a song',
  correlationId: 'my-correlation-id',
  // ...
});

result.correlationId; // 'my-correlation-id'
```

These correlation IDs can be passed to feedback:

```ts
// ...

agent.addFeedback({
  reward: -1,
  correlationId: result.correlationId,
});
```
