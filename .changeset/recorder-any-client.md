---
"@statelyai/agent": patch
---

`createRecorder` records any client: `recorder.fn(name, asyncFn, options?)` and `recorder.client(name, client, { methods })` record each call as a `call` effect (arguments, result or error, stream chunks), and replay answers it by name and order with no network. `redact`, `serialize`, and `revive` control what is recorded and returned; `compareRecordings` reports `call-name`, `call-args`, and `call-result`.
