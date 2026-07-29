---
"@statelyai/agent": minor
---

Every `runAgent` result now carries `events`, a versioned, strictly JSON-safe `AgentLogEntry[]` needed to replay the run without executing model or tool calls. Entries include identity, acceptance time, machine identity/version, and state/effect verification hashes. Capture new entries in flight with `onEvent`, and pass a preceding result's `events` back when resuming by snapshot to retain one complete replay history across runs.

Add strict replay verification, event-id forking, and structural event-log diffs. Replay rejects machine mismatches and reports the first state/effect divergence.

Require XState `6.0.0-alpha.25` or newer. Agent APIs now match XState's renamed source surface: use `actors`, `machine.sources.actors`, and callback `actors` instead of `actorSources`/`machine.implementations.actorSources`.

Replay uses XState's canonical internal event protocol: actor completions carry `actorId`/`sessionId`, while delayed work is replayed from `xstate.timer` events. Replay rebinds globally unique actor sessions when folding the log through a new actor system.
