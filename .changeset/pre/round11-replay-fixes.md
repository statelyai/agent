---
"@statelyai/agent": patch
---

- `StandardSchemaV1` accepts schemas whose `types` is `| undefined`, so zod 4 schemas keep their types under `exactOptionalPropertyTypes`.
- A recorded stream that fails replays its chunks, then the error, in `recorder.fn`, `recorder.client`, and the OpenAI seam. An OpenAI stream that fails midway now records the error.
- Recorded errors keep `cause` and an `AggregateError`'s `errors`; replay restores them. `createRecorder` and `checkParity` take `reviveError` to rebuild error classes for `instanceof` checks.
- Docs and the loop-to-machine skill cover async generator loops, class seams on both sides of parity, and host cancel registries with `runAgent`'s asynchronous start.
