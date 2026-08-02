---
"@statelyai/agent": minor
---

**Every `runAgent` result now carries `events`: the replayable log of the run.** A versioned, strictly JSON-safe `AgentLogEntry[]` that reproduces the run without executing a single model or tool call.

```ts
const saved: AgentLogEntry[] = [];
await runAgent(machine, { input, executors, onEvent: (entry) => saved.push(entry) });
// After a crash the log alone is enough — no snapshot, no re-called models.
const resumed = await runAgent(machine, { events: saved, executors });
```

- Entries carry identity, acceptance time, machine identity/version, and state/effect verification hashes. Capture them in flight with `onEvent`, or pass a preceding result's `events` back when resuming by snapshot to keep one complete replay history across runs.
- Strict replay verification, event-id forking, and structural event-log diffs: replay rejects machine mismatches and reports the first state/effect divergence (`verifyReplay`, `diffEventLogs`, `createReplayEntry`).
- **Requires XState `6.0.0-alpha.25` or newer.** Agent APIs match XState's renamed source surface: use `actors`, `machine.sources.actors`, and callback `actors` instead of `actorSources` / `machine.implementations.actorSources`.
- Replay uses XState's canonical internal event protocol: actor completions carry `actorId`/`sessionId`, delayed work replays from `xstate.timer` events, and globally unique actor sessions are rebound when folding the log through a new actor system.
