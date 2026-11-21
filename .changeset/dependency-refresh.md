---
"@statelyai/agent": patch
---

Require XState 6.0.0-beta.4. Host-owned timers: `cancel(id)` now receives the id that `schedule` was given (XState beta.4 adds an `occurrence` to scheduled timer keys but cancels by the key without it), and an in-process timer cancelled by leaving its state is cleared instead of left pending. Support `@tanstack/ai` 1.7: the TanStack AI adapter now counts usage through `chat()`'s `onUsage` hook, so a combined structured output whose final answer fails to parse still reports that turn's tokens on the error, and it fills the `threadId` that `chat()` requires (host settings can set it). The AI SDK adapter maps the new `'interrupted'` finish reason to `'other'`. `setupAgent.fromConfig` keeps the default id of a state with `onDone`, so `#<id>.<path>` targets reach it.
