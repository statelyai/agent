---
"@statelyai/agent": patch
---

- `createAgentInbox` and `runtime.send`: an event the host sends is handed out ahead of completions the run already holds. Before, a send landed only once the machine stopped when its actors settled in microtasks, so a pause sent before start or mid-run was never applied.
- `canReach` ordering targets check `reach` on the step that matched `after` too: what the trigger's own transition starts comes after it. Before, a turn started in the trigger's step was missed.
- `createGeneratorBridge`: a consumer that pulls a value yielded while unwinding resumes the pass, as `yield*` does. `forward` reports `closed: false` (its `value` is then `undefined`), and `stream` hands a failed run back instead of throwing it.
