---
"@statelyai/agent": minor
---

`agent.decide` now delivers its chosen event automatically, and `sendDecision` is removed (breaking).

When a decision resolves under `runAgent`, the chosen event is sent to the invoking actor directly (mirroring `agent.plan`) and the invoke completes with that event as its output. The delivered event's transition (defined by the state's own `on:`) usually exits the invoking state, which cancels the invoke, so `onDone` normally never fires. If the transition stays in-state, the invoke completes and an explicit `onDone` (now optional and rarely needed) observes the chosen event as output. `onError` (retries exhausted) is unchanged.

Because delivery is built in, `sendDecision` is gone: no `onDone: sendDecision()`, no import, no deprecation shim. Remove those lines; delivery already happens. In JSON workflows (`setupAgent.fromConfig`), a decide invoke no longer auto-wires `onDone` and no longer rejects a declared `onDone`.

New: `defineModels` helper (exported from `@statelyai/agent/ai-sdk`). An identity function whose return type is the nameable `AiSdkModelMap<keyof T & string>`, so an exported `const models = defineModels({ ... })` needs no `Record<'a' | 'b', LanguageModel>` annotation and never trips TS2742: model-ref keys still infer at `createAiSdkExecutors({ models })` and `setupAgent({ models })`.
