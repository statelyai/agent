# The event log

The event log is an append-only journal of the external inputs a machine consumed. It is the source of truth for a run: `replay` folds it back into a snapshot without executing anything.

## What is journaled

Only external inputs, in the order the run accepted them:

- The reserved `@agent.init` first entry, carrying machine `input` or a persisted `snapshot`.
- Host-sent events.
- Child completions: `xstate.done.actor` and `xstate.error.actor`, with output inline.
- Timer firings.
- `@agent.usage` spend records and `agent.messages` events.

Raised and internal events are never journaled. Replay re-derives them from the machine's own logic, so journaling them would apply them twice.

Recorded results are never re-executed. A model call whose completion is in the log runs zero times on replay.

## Entry shape

```ts no-check
interface AgentLogEntry {
  schemaVersion: 1;
  id: string;
  index: number;
  recordedAt: string;
  machineId: string;
  machineVersion: string;
  event: EventObject;
  causationId?: string;
  metadata?: Record<string, JsonValue>;
  verification?: { stateHash: string };
}
```

- `recordedAt` is acceptance metadata, not machine time. A transition that needs time takes it from the event.
- `machineVersion` is the machine's declared `version`, or its structural hash when none is declared.
- `verification.stateHash` is the hash of the persisted snapshot after the entry is applied.
- `metadata` is host-owned and stored verbatim. The init entry's `metadata.executionId` names the lineage; read it with `getLogExecutionId(entries)`.

Entries are strict JSON. `createReplayEntry`, `initEntry`, and every store append reject values JSON would drop or coerce (`undefined`, functions, symbols, bigint, non-finite numbers, `Date`, `Map`, `Set`, class instances, cycles) with `NonSerializableAgentEventError`, which carries the offending `path`. `Error` payloads on `xstate.error.actor` are normalized to `{ name, message, cause? }`. Use `assertJsonSerializable` and `assertAgentLogEntry` at custom transport boundaries.

## Record a log

`runAgent` returns a complete, self-contained segment as `result.events`, and calls `onEvent` once per newly accepted entry as the run proceeds, init entry first.

```ts no-check
const appended: AgentLogEntry[] = [];

const result = await runAgent(machine, {
  input,
  executors,
  onEvent: (entry) => appended.push(entry)
});
```

`onEvent` is synchronous: it observes an entry after XState accepted it and cannot await a store before the transition. Buffer entries there and flush them to the store. Execution is at-least-once, not append-before-execute.

To build entries yourself, use `initEntry` for index 0 and `createReplayEntry` for each subsequent external input.

## Replay

`replay` is a pure fold. No actor starts, no action runs, no model is called.

```ts no-check
const { snapshot, persistedSnapshot } = replay(machine, entries);
```

- The first entry seeds the fold: `input` folds from `initialTransition`, `snapshot` restores purely and the rest of the log folds onto it.
- `replay(machine, entries.slice(0, n))` rebuilds the state as of any point in the log — time travel with no side effects.
- Journaled child sessions are rebound to the sessions the current fold minted, so completions still apply.

## Verification

Every entry carries `verification.stateHash` by default. `replay` checks it as it folds.

| `verify` | Behavior |
| --- | --- |
| `true` (default) | Checks entries that carry a hash; entries without one pass. |
| `'strict'` | Requires a hash on every entry. |
| `false` | No checks. |

```ts no-check
try {
  replay(machine, entries, { verify: "strict" });
} catch (error) {
  if (error instanceof AgentReplayDivergenceError) {
    console.error(error.eventId, error.index, error.kind);
  }
}
```

- `kind: "state"` means the machine derived a different state than the one recorded.
- `kind: "missing-verification"` means an entry carried no hash under `'strict'`.
- `AgentMachineVersionMismatchError` rejects an entry stamped for another machine id or version before folding it. The init-with-snapshot entry is exempt: that entry is the version bridge.

Structural hashing cannot see function bodies or validator implementations. Bump the machine's own `version` when those semantics change.

## Hazards

Replayability rests on pure transitions.

- Keep transitions, guards, and request inputs pure functions of state and event. `Date.now()` or `Math.random()` in a guard produces a different fold and throws `AgentReplayDivergenceError` on the next replay. Inject time and randomness as events or as input.
- Never mutate a journaled entry. There is no update and no delete. Rewriting an entry invalidates every hash after it; fork instead.
- Journal external inputs only when building entries by hand.
- Keep context JSON-serializable. Hold sessions, clients, and sockets in closures and store only their ids.
- Replay against the machine `runAgent` folded. When actors come in through `runAgent({ actors })`, call `replay(machine.provide({ actors }), entries)`. The executor-bound machine is never needed; recorded results replace executors.
- A run whose initial state cannot be serialized to JSON produces no log: `result.events` is empty and `onEvent` never fires. `replay` rejects a log without an init entry, so `runAgent` journals nothing rather than a suffix.

## Fork

`forkEventLog(entries, upToIndex)` returns the prefix `[0, upToIndex)` as a new, still self-contained log. `upToIndex` is exclusive and must leave the init entry in place. A fork copies the init entry, so it inherits the parent's execution id.

```ts no-check
const branch = forkEventLog(entries, 8);
```

`store.fork({ threadId, newThreadId, upToIndex })` does the same at the storage layer. To diverge, append different entries to the new thread.

## Usage totals

`getUsageFromEvents(entries)` folds the `@agent.usage` entries into one cumulative total. The log is the source of truth, so the totals are a projection of it rather than a host-side accumulator. See [Usage and budgets](usage-and-budgets.md).

## Stores

`AgentEventLogStore` is the one interface a host implements. It is append-only, with optimistic concurrency on log length.

```ts no-check
const store = createInMemoryEventLogStore();

await store.append({ threadId: "session-1", expectedIndex: 0, entries: [initEntry(machine, { input })] });

const recent = await store.read("session-1", { from: 3 });
const next = await store.length("session-1"); // the next expectedIndex
```

- `append` is atomic. A stale writer fails with `AgentEventLogConflictError`, carrying `threadId`, `expectedIndex`, and `actualIndex`, so two hosts resuming one thread resolve to exactly one winner. Entry indices must be contiguous from `expectedIndex`, and ids unique within the thread.
- `read` and `length` are the only reads. Everything else about a thread is derived from its entries.
- `fork` copies a prefix onto a fresh thread.

`createInMemoryEventLogStore()` is the reference implementation. No SQLite or database store ships with the package: hosts own durability. An append-only table with a `(thread_id, index)` primary key maps onto any database.

## Store conformance

```ts no-check
await assertEventLogStoreConformance(() => createMyStore(), { describe, it });
```

The suite runs a host-written store against the reference on races, isolation, ordering, and fork semantics. It drives any test runner, or a plain script.

## Related

- [Persistence](persistence.md): persisting the log, snapshot-as-cache, and the version bridge.
- [Hosts and executors](hosts.md): idempotency keys for at-least-once execution.
- [Observability](observability.md): traces alongside the log.
