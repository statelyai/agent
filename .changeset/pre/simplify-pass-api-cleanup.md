---
"@statelyai/agent": minor
---

Simplification pass across the codebase and docs, with a few breaking API cleanups:

- **Breaking:** `executeAgentRequest(request, executors)` now always returns `Promise<{ output, raw }>`. The `{ verbose: true }` option and the output-only overload are gone; destructure `output` where you previously took the bare return value.
- **Breaking:** `ScriptedDecisionValue`'s event-envelope arm no longer carries a `[key: string]: unknown` index signature, so the union discriminates properly. A `ChosenEvent` is still identified by its string `type`, even when its payload has an `event` key.
- **Breaking (internal):** `getAgentRequestsWith` merged into `getAgentRequests(actions, options)`; pass `{ machine, snapshot }` in options.
- `SeamTurn.meta` is now typed from the machine's own meta schema instead of `Record<string, unknown>`; `MetaOfSnapshot` is exported from utils.
- `JsonSerializableTraceEvent` is now derived from `AgentTraceEvent`, so new trace variants can no longer silently miss the JSON-safe side (same shape, alias form in d.ts).
- `onChunk`, `onResult`, and `onTransition` are implemented as projections of the `onTrace` stream (documented as sugar; same payloads, order, and timing).
- The internal usage reader is unified under the public name `getCallUsage` (implementation was previously duplicated behind `extractCallUsage`).
- Bug fix: `simulateAgent` no longer drains the caller's `script.text` queues (they are now copied like `decisions`/`invokes`).
- Removed dead code (`resolveAgentRequests`, unused fields, unexported error subclasses, identity wrappers), deduplicated internal helpers, and consolidated docs so each concept has one owning page.
