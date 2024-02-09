---
'@statelyai/agent': patch
---

Add `adapter.fromToolChoice(…)`, which creates an actor that chooses agent logic based on a input.

```ts
const actor = adapter.fromToolChoice(() => 'Draw me a picture of a donut', {
  // tools
  makeIllustration: {
    description: 'Makes an illustration',
    src: fromPromise(/* ... */),
    inputSchema: {
      /* ... */
    },
  },
  getWeather: {
    description: 'Gets the weather',
    src: fromPromise(/* ... */),
    inputSchema: {
      /* ... */
    },
  },
});

//...
```
