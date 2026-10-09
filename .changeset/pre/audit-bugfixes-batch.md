---
"@statelyai/agent": patch
---

Six correctness fixes from a source audit:

- **ai-sdk `streamText` now honors `metadata.maxSteps`**: like `generateText`, so a streaming tool loop is bounded instead of running unbounded (both share one `maxStepsSetting` helper).
- **openai-compat `decide` now forwards an abort signal**: `resolveDecision` threads its `options.signal` onto the request (`AgentDecisionRequest.signal`), and both adapters forward it to the underlying model call, so an in-flight decision is cancellable (symmetric with the text executors).
- **`RunAgentResult` error `cause` split**: the overloaded `'machine'` is now `'machine' | 'decision-exhausted' | 'stopped'`: an unhandled `DecisionExhaustedError` (or one wrapped in the error's `cause` chain) settles `'decision-exhausted'`, an external stop settles `'stopped'`, and any other machine error state stays `'machine'` (`'aborted'`/`'max-model-calls'` unchanged).
- **Reserved `agent.*` actor keys are enforced**: `setupAgent({ actors })`/`{ requests }` now throws if a key collides with a builtin (`agent.generateText`, `agent.streamText`, `agent.userInput`, `agent.decide`, `agent.plan`) instead of silently clobbering it via spread order. Deliberate overrides are still possible via `machine.provide({ actors })`.
- **Dev-only snapshot-serialization warning**: when a run settles idle, in non-production it walks the machine context once and `console.warn`s (at most once per run, naming the offending path) if it holds a value that won't survive JSON persist/resume (`Date`, `Map`, `Set`, function, `undefined`, `bigint`, class instance, circular). Never throws.
- **Decision adapters: the event's own `type` always wins**: confirmed both adapters already spread the chosen event's `type` last, so a stray `type` key in the model's tool input can never override the machine event type; added regression tests locking this in.
