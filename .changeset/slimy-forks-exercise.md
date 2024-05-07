---
'@statelyai/agent': patch
---

Reduces API to one function: `createAgent(…)`. This creates an agent that:

- Is actor logic for an agent that makes decisions based on a goal
- Has `.fromText(…)` and `.fromTextStream(…)` helpers
- Wraps the [`ai`](https://sdk.vercel.ai/docs) library
