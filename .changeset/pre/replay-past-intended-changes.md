---
"@statelyai/agent": patch
---

**Replay ports that change on purpose.** `createRecorder({ replay })` now answers each model call with the earliest unused recorded call of the same method and shape, and each tool call with the earliest unused recorded call of the same name and input, instead of by position. A call the port added or dropped no longer shifts the answers after it, unless another call has the same shape (or tool name and input): those are answered in recorded order.

- `translate(recorded, actual)` adapts a recorded answer to a call you changed on purpose (a stream that became `doGenerate`, text that became a decision). `compareRecordings` counts the pair as the same call.
- `fallback: { model, openai, tools }` answers what the recording cannot: a stand-in model or client answers the call, and the wrapped tool runs. Those effects are marked `unrecorded` and still count as extra.
- `compareRecordings(a, b, { kinds: ["tool", "output"] })` compares only what a port did, for a port that calls the model another way.
- `normalize(effect, index, effects)` can return `undefined` to leave an effect out of the comparison, such as a repeated idempotent write. Replay still answers from it.
- `recorder.model` wraps a decision model's `doDecide` (and `doEvaluate`). Its shape is the questions, their choice options, and their score levels.
- A recorded error keeps its number and boolean fields (`statusCode`, `isRetryable`) and its `Symbol.for` markers. In replay, `APICallError.isInstance` and retry behavior hold. Comparisons still check only an error's name, message, and code.
