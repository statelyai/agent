---
"@statelyai/agent": minor
---

Two `runAgent` additions for human-in-the-loop resume:

- **Explicit suspension detection.** Declare what "suspended" means for a machine with `setupAgent({ isSuspended: (snapshot) => boolean })`: a wait-state predicate the machine carries (it survives `machine.provide(...)`), so `runAgent` settles those resting snapshots idle deterministically instead of relying on the `setTimeout(0)` timing heuristic. You choose the signal — a tag, a state match, or a `meta` field (e.g. `(s) => s.hasTag('awaiting-review')` or `(s) => getStateMeta(s).interaction !== undefined`). `RunAgentOptions.isSuspended?: (snapshot) => boolean` remains a per-run host override. Resolution order: host option → machine-carried predicate → timing heuristic (when neither is present). Whole-machine idle semantics and the `agent.userInput` placeholder exemption are unchanged; a machine with no predicate falls back to the heuristic exactly as before. (Provisional name: `isSuspended` may change before 2.0.) **Breaking:** the previously exported `WAIT_TAG` constant and the `hasTag(WAIT_TAG)` default are removed — declare your own signal via `setupAgent({ isSuspended })` or the `runAgent` option.

- **Illegal resume events throw.** Resuming with `{ snapshot, event }` whose `type` the restored state cannot take now throws `IllegalResumeEventError` (carrying `eventType` and `acceptedTypes`) before delivering the event — a programmer error in the same class as `runAgent`'s bind-time throws, rather than a silent drop. A type-legal event a guard rejects is not an error (the machine takes no transition and settles normally). Opt out with `RunAgentOptions.onIllegalResumeEvent: 'ignore'` to restore the older silent behavior. `IllegalResumeEventError` is exported.
