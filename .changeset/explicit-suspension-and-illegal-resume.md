---
"@statelyai/agent": minor
---

Two `runAgent` additions for human-in-the-loop resume:

- **Explicit suspension detection.** New exported `WAIT_TAG` (`'agent.wait'`): put it in a state's `tags` to mark an intentional wait for an external event. When the machine rests in a tagged snapshot and nothing is in flight, `runAgent` settles idle deterministically instead of relying on the `setTimeout(0)` timing heuristic. New `RunAgentOptions.isSuspended?: (snapshot) => boolean` customizes detection (default `(s) => s.hasTag(WAIT_TAG)`). Whole-machine idle semantics and the `agent.userInput` placeholder exemption are unchanged, and untagged machines fall back to the heuristic exactly as before — fully backward compatible. (Provisional name: `isSuspended` may change before 2.0.)

- **Illegal resume events throw.** Resuming with `{ snapshot, event }` whose `type` the restored state cannot take now throws `IllegalResumeEventError` (carrying `eventType` and `acceptedTypes`) before delivering the event — a programmer error in the same class as `runAgent`'s bind-time throws, rather than a silent drop. A type-legal event a guard rejects is not an error (the machine takes no transition and settles normally). Opt out with `RunAgentOptions.onIllegalResumeEvent: 'ignore'` to restore the older silent behavior. `IllegalResumeEventError` is exported.
