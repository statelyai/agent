---
"@statelyai/agent": minor
---

**Alpha API consistency pass.** Breaking renames and removals to settle the surface before 2.0 stable.

Renames:

- `isSuspended` → `isIdle` and `suspendedTags` → `idleTags`, matching `status: 'idle'`.
- `canReach` returns `{ reachable, witness }` (was `{ canReach, witness }`).
- `AgentEventLogConflictError.actualLength` → `actualIndex`.
- `createLoopMachine({ maxIterations })` → `maxTurns`; `createToolLoopMachine({ maxTurns })` → `maxSteps`.
- Budget breach error code `max-model-calls-exceeded` → `max-model-calls`, thrown as the exported `AgentMaxModelCallsExceededError` so `onError` can branch on `event.error.code`.

Removals:

- `persistSnapshot`: use XState-native `actor.getPersistedSnapshot()`, `machine.getPersistedSnapshot(snapshot)`, or `result.persistedSnapshot`.
- `verifyReplay`: use `replay(machine, events, { verify: 'strict' })`.
- `assertAgentMachine`: use `lintAgentMachine(machine, { throw: true })`.
- `explorePaths({ textOutputs })`: use the `text`, `invokes`, and `userInput` channels.
- `fork({ atEventId })`: `upToIndex` (exclusive) is the only fork address.
- `runAgent({ onIllegalResumeEvent })`: illegal resume events always reject.
- `runAgent({ machineVersion })`: `createMachine({ version })` is the single source, with a structural hash fallback for unversioned machines. A machine declaring XState-native `migrate` owns version mismatches.
- `runSeam` `{ model }` seam form: seams are addressed by `{ request, occurrence }`; the implicit last-entry repeat is now opt-in `repeatLast: true`.
- The tool-loop preset's `interruptOn` metadata convention (core never acted on it; tool-call gating is on the roadmap).

Behavior changes:

- `'*'` transitions now receive `@agent.usage` (plain XState wildcard semantics). Model-facing `allowedEvents` still excludes `@agent.*`.
- `provideExecutors` binds executors recursively into child agent machines, same as `runAgent`.
- `decide` executors take `(request, info)` like the text executors, and `resolveDecision(request, executors, options)` takes the executor set (`missing-decide-executor` error code).
- Requests take a typed top-level `maxSteps` (the AI SDK adapter still reads `metadata.maxSteps` as a fallback).
- `setupAgent` throws for any `requests`/`actors` key starting with `agent.` (reserved prefix).
- All scripted queues throw when they run dry; `createScriptedExecutors` and `simulateAgent` scripts gain a `userInput` queue.
- `getStateMeta` merges deterministically: deeper states win, and equal-depth parallel siblings merge by state id.

New:

- `validateAgentConfig(config)` at `@statelyai/agent/validate` (Ajv is an optional peer; the root bundle stays dependency-free).
- `getSnapshotRequests(snapshot, options)` and `getSnapshotNodes(snapshot)` replace reading `snapshot._nodes` when hosting request interpretation.
