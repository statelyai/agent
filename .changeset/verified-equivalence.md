---
"@statelyai/agent": patch
---

**Verified equivalence for ports.** `@statelyai/agent/testing` adds `createRecorder` and `compareRecordings`. Record a run of the code you are replacing by wrapping its AI SDK model (`recorder.model`) or `openai` client (`recorder.openai`) and its tools (`recorder.tool`, `recorder.tools`). Then replay the recording against the machine: `createRecorder({ replay })` answers every model and tool call from the recording, with no API key and no side effects. `compareRecordings` reports the first effect that differs: a model call (count and shape), a tool call or its arguments, or the output. The `loop-to-machine` skill records golden runs and proves equivalence with them.
