---
'@statelyai/agent': patch
---

Add `adapter.fromTool(…)`, which creates an actor that chooses agent logic based on a input.

```ts
const actor = adapter.fromTool(() => 'Draw me a picture of a donut', {
  // tools
  makeIllustration: {
    description: 'Makes an illustration',
    run: async (input) => {
      /* ... */
    },
    inputSchema: {
      /* ... */
    },
  },
  getWeather: {
    description: 'Gets the weather',
    run: async (input) => {
      /* ... */
    },
    inputSchema: {
      /* ... */
    },
  },
});

//...
```
