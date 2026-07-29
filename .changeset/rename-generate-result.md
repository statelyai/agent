---
"@statelyai/agent": minor
---

Rename `runAgentToCompletion` to `generateResult`, and resolve with the done result instead of the bare output: `result.output` plus run metadata (`result.snapshot`, replayable `result.events`), mirroring `generateText`'s `text` + call metadata shape. Still throws `AgentIdleError` on an unexpected idle. New exported type: `GenerateResult<TMachine>`. Migration: `const result = await generateText(...)` becomes `const result = await generateResult(machine, { input, executors })`.
