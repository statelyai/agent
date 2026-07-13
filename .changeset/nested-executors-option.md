---
"@statelyai/agent": minor
---

**Breaking:** `runAgent` / `runAgentToCompletion` no longer accept flat `generateText`, `streamText`, and `decide` options. Host executors are now passed as a single nested `executors` option — the same `AgentRequestExecutors` set the step path (`executeAgentRequest` / `resolveAgentRequests`) takes:

```ts
// before
await runAgent(machine, { input, ...createAiSdkExecutors({ models }) });
await runAgent(machine, { input, generateText, decide });

// after
await runAgent(machine, { input, executors: createAiSdkExecutors({ models }) });
await runAgent(machine, { input, executors: { generateText, decide } });
```

Every slot in `executors` is optional (`Partial<AgentRequestExecutors>`): each executor kind is still bind-time-checked only when the machine actually reaches a request of that kind, so e.g. a stream-only machine may pass `executors: { streamText }` alone. `userInput` stays a top-level option.
