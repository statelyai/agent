---
"@statelyai/agent": major
---

Breaking: canonical `{ output }` executor envelope, optional `generateText` on `runAgent`, and unified `onChunk`.

- **Executors must return `{ output }`.** A `generateText`/`streamText` executor (and a `TextLogic` `.withExecutor(...)` callback) must now return an envelope `{ output: <value> }`, where `output` is the text string or structured object. Optional passthrough fields (usage, toolCalls, finishReason, raw, ...) are allowed alongside `output`. The old silent unwrapping of `object` / `text` / bare values is removed: a non-envelope return is a runtime error naming the request id ("executors must return { output }"). `withExecutor` is typed from the logic's output schema, so `{ output: T }` is inferred and a wrong shape is a compile error. `createAiSdkExecutors` now returns `{ output }` from both `generateText` and `streamText`.
- **`generateText` is optional on `runAgent`.** A machine with only plain actors (no text or decision request) runs with zero executors. A missing `generateText`/`streamText`/`decide` remains a loud bind-time error when the machine actually invokes an unbound text/decision source.
- **`onChunk` is unified to `(chunk, { request })`** across `runAgent` and the AI SDK per-actor streaming wrappers.
