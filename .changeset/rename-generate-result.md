---
"@statelyai/agent": minor
---

**Renamed `runAgentToCompletion` to `generateResult`, and it now resolves the whole done result instead of the bare output** — `result.output` plus run metadata (`result.snapshot`, replayable `result.events`, `result.usage`), mirroring `generateText`'s text-plus-metadata shape. Still throws `AgentIdleError` on an unexpected idle. New exported type `GenerateResult<TMachine>`.

```ts
// Before
const output = await runAgentToCompletion(machine, { input, executors });
// After
const result = await generateResult(machine, { input, executors });
result.output;
```
