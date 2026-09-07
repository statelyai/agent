---
"@statelyai/agent": minor
---

`runAgent` accepts untrusted wire events, and script faults now fail the run.

**`resumeEvent`** — a new option that takes an unvalidated event (a request body, a socket frame) instead of the typed, trusted `event`. Before the actor starts, `runAgent` checks that it is an object with a string `type`, that the restored state accepts that type, and that its payload satisfies the machine's registered event schema. A failure settles `{ status: "error", cause: "invalid-event", error }` — nothing runs, no log entry is appended, so the thread is untouched. `error` is `AgentIllegalResumeEventError` for a wrong type, the new `AgentInvalidEventPayloadError` (code `invalid-event-payload`) for a bad payload. On success the schema-parsed event is delivered.

A host resuming from `store` + `threadId` no longer replays the log itself just to validate an event:

```ts
const result = await runAgent(machine, { store, threadId, resumeEvent: await request.json(), executors });
if (result.status === "error" && result.cause === "invalid-event") {
  return Response.json({ error: String(result.error) }, { status: 400 });
}
```

`event` is unchanged: still typed to the machine's event union, and an illegal type still throws `AgentIllegalResumeEventError`. Pass one or the other, never both.

**`cause: "script"`** — a text or decision executor that faults with an `AgentScriptedExecutorError` (unknown request name, exhausted queue) now settles the run `{ status: "error", cause: "script", error }` immediately. Previously the fault reached the machine's `onError`, where a misconfigured script produced a plausible-looking outcome. A machine whose `onError` routed a script fault to a final state now reports `error` / `script` instead of `done`.
