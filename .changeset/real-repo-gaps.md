---
"@statelyai/agent": patch
---

**Fixes from porting five real agent repos.**

- **Adapter SDKs install next to any version.** The optional peers `ai`, `openai`, `@tanstack/ai`, and `ajv` have no version range, so an app on `ai` 4 or `openai` 4 installs the core without `--legacy-peer-deps`. The adapters still need the versions in the readme, and fail when imported or called with older ones.
- **A decision answer that names no event is retried.** The AI SDK, OpenAI, and TanStack AI adapters no longer throw when the model calls no tool, calls a tool that was not offered, or sends arguments that are not JSON. Each is a failed `'unknown-event'` attempt that is fed back to the model, and exhausting retries throws `AgentDecisionExhaustedError` as before. TanStack AI's `generateText` now returns a tool call with malformed arguments (marked `invalid: true`) instead of throwing a `SyntaxError`.
- **Tool-loop steps count as model calls.** An executor result may report `modelCalls`, and the adapters report one per step. `usage.modelCalls` and `maxModelCalls` count them; the loop's request is admitted as one call, so the call after it is the one refused.
- **The machine can read its budget.** `@agent.usage` carries `budget: { modelCalls, maxModelCalls }`.
- **`modelCallsSpent`** counts earlier turns of a conversation against `maxModelCalls` without adding them to this run's `usage`. `runAgent` with `onIdle` uses it between passes.
- **`firstDivergence(actual, reference, { key: "payload" })`** also compares event payloads, so a fault that changes an output but no state is found. For deterministic or mocked runs.
