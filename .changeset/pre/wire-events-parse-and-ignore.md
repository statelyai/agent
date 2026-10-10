---
"@statelyai/agent": minor
---

Events off the wire are parsed at the boundary, and an event the state does not handle is ignored rather than refused.

State machines ignore events they have no transition for. The library no longer turns that into an error.

**`parseAgentEvent(machineOrSnapshot, payload, options?)`** is the one boundary parser. It takes `unknown` (hand it `await request.json()`), reads the event schemas `setupAgent` registered on the machine, and returns the event typed as the machine's event union. It throws the new `AgentInvalidEventPayloadError` (code `invalid-event-payload`) when the payload is not an object with a string `type`, names a reserved `@agent.*` type, or fails its registered schema. It does not look at the current state: payload shape is what a schema can check.

```ts
let event;
try {
  event = parseAgentEvent(machine, await request.json());
} catch (error) {
  return Response.json({ error: String(error) }, { status: 400 });
}

const result = await runAgent(machine, { store, threadId, event, executors });

if (result.ignored) {
  return Response.json({ error: `'${result.ignored.type}' does not apply here` }, { status: 409 });
}
```

**`result.ignored`** is the resume event the root actor took no transition for (no state change, no actions). The run settles normally, usually back to `idle` at the same state. The event is still journaled like any other external input, so a replay ignores it again. A host that wants a 4xx checks this; nothing else has to.

**Breaking (alpha):**

- `AgentIllegalResumeEventError` is removed. `runAgent({ snapshot, event })` no longer throws when the restored state has no transition for `event` — it sends it and reports `result.ignored`.
- `parseAgentEvent` no longer throws on an event type the current state does not accept, and no longer takes `eventToolName`. It now accepts a machine as well as a snapshot, and an `unknown` payload.
- `eventFromInteraction` throws `AgentInvalidEventPayloadError` instead of `AgentIllegalResumeEventError` for a choice the interaction does not offer.
