---
"@statelyai/agent": patch
---

- `wrapWorkflow`: `run(input, { live })` passes a live object to the workflow as `context.live`, so one wrapped workflow serves every instance of a class-shaped loop. When the workflow types `live`, every `run` call must pass it.
- `abortWith.event` can be a function of `signal.reason`, so aborts with different reasons send different events.
- `runAgent({ onIdle: "inbox" })`: an idle state waits for the next inbox send. Needs `inbox`.
