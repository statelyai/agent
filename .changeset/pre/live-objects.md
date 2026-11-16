---
"@statelyai/agent": patch
---

Bind live objects per run:

- `runAgent` and `createAgentRuntime` take `actions`, merged onto the machine like `actors`. Keys and params are checked against the actions declared in `setupAgent`.
- `setupAgent` keeps the declared action types, so `actions.name` in a transition is typed and a misspelled name is a type error.
- `checkParity` takes `setup: (scenario, side) => liveObject`, called once per side; its result is passed to `effects`, `before` and `after`.
