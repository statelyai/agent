---
"@statelyai/agent": minor
---

**Normalized `finishReason`.** Executor results can report why a call stopped, as `'stop' | 'length' | 'tool-calls' | 'content-filter' | 'other'` (the `AgentFinishReason` type). `createAiSdkExecutors` sets it on every text, structured, and streamed result, mapping the provider's vocabulary onto those five and leaving the raw value on `raw`. `runAgent` lifts it onto the `request.end` trace event next to `usage`, and `serializeTraceEvent` passes it through.

**`AgentTruncatedError`.** A `'length'` finish costs different things for different requests, so the adapter throws only when it would otherwise return nothing usable:

- Text request: the text it did produce comes back, with `finishReason: 'length'`. Nothing throws.
- Structured request: an envelope that never closed is not an answer, so `createAiSdkExecutors` throws.

The error extends `AgentError` with the code `'truncated'` and carries `requestName`, `requestId`, and `partialOutput`, so an invoke branches on it without an `instanceof` check across bundles:

```ts
onError: [
  { guard: ({ event }) => event.error.code === "truncated", target: "askingForLess" },
  { target: "failed" },
];
```

Core never throws it. Truncation is a host observation — only an adapter knows a call ran out of tokens.
