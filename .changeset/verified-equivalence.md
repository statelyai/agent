---
"@statelyai/agent": patch
---

**Verified equivalence for ports.** `@statelyai/agent/testing` adds `createRecorder` and `compareRecordings`. Record a run of the code you are replacing by wrapping its AI SDK model (`recorder.model`) or `openai` client (`recorder.openai`) and its tools (`recorder.tool`, `recorder.tools`). Then replay the recording against the machine: `createRecorder({ replay })` answers every model and tool call from the recording, with no API key and no side effects. `compareRecordings` reports the first effect that differs: a model call (count and shape), a tool call or its arguments, or the output. The `loop-to-machine` skill records golden runs and proves equivalence with them.

- `createOpenAiExecutors` accepts `api: "responses"` to call the OpenAI Responses API (`client.responses.create`) instead of Chat Completions, so a port of Responses-based code makes the same calls and replays its recordings. `compareRecordings` lists every divergence (`divergences`), aligned so one extra call does not shift the rest. A `modelCalls` function allows a model call's shape to change on purpose, per call, in replay and in comparison. A tool the original ran synchronously replays synchronously.
