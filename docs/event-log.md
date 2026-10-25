# The event log

The event log is an append-only journal of the external inputs a machine consumed. It is the source of truth for a run: `replay` folds it back into a snapshot without executing anything.

`createAgentRuntime(machine, { store, threadId })` writes and reads the log for you. The primitives on this page (`replay`, `forkEventLog`, `initEntry`, `createReplayEntry`, the stores, and the conformance suite) are in `@statelyai/agent/log`.

## What is journaled

Only external inputs, in the order the run accepted them:

- The reserved `@agent.init` first entry, carrying machine `input` or a persisted `snapshot`.
- Host-sent events.
- Child completions: `xstate.done.actor` and `xstate.error.actor`, with output inline.
- Timer firings.
- `@agent.usage` spend records.

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
  attempts?: DecisionAttempt[];
}
```

- `recordedAt` is acceptance metadata, not machine time. A transition that needs time takes it from the event.
- `machineVersion` is the machine's declared `version`, or its structural hash when none is declared.
- `verification.stateHash` is the hash of the persisted snapshot `replay` folds to after the entry is applied. A run records replay's fold, not its live snapshot: replay never starts children, so a live child that already settled while its completion waits to be delivered is not part of the hash. So the hash checks each entry against the fold of the entries before it, not that the log is complete or that the fold matches the live run. A dropped last entry leaves the remaining hashes intact, an altered event that folds to the same state still matches, and a machine that reads something the log does not keep can replay to a different state. Compare the replayed context and output with the live result in a test.
- `metadata` is host-owned and stored verbatim. The init entry's `metadata.executionId` names the lineage; read it with `getLogExecutionId(entries)`.
- To stamp a run with what produced it (a policy version, model ids, a scenario), pass `metadata` to `createAgentRuntime` or `runAgent`. It lands on the init entry next to `executionId`, which is reserved. A resume keeps the stamp of the run that started the log; a version bridge opens a new segment stamped with the bridging run's `metadata`. A value that is not JSON throws before the run starts.
- `attempts` holds the decision attempts the machine did not accept before this entry's event landed. Replay ignores it. See [Decision attempts](#decision-attempts).

Entries are strict JSON, and plain objects and arrays from another realm (a jest test's vm context) count as JSON. Object fields set to `undefined` in an input or event are dropped, as `JSON.stringify` drops them. `createReplayEntry`, `initEntry`, and every store append reject the other values JSON would drop or coerce (functions, symbols, bigint, non-finite numbers, `Date`, `Map`, `Set`, class instances, cycles, `undefined` array items) with `NonSerializableAgentEventError`, which carries the offending `path`. `Error` payloads on `xstate.error.actor` are normalized to `{ name, message, code?, cause?, "@error": true }`, keeping `code` when it is a string or a number; an `AgentDecisionExhaustedError` also keeps its `attempts`. `replay` turns objects marked `"@error"` back into `Error` objects, so an `onError` that checks `instanceof Error` takes the same branch on replay. A thrown plain object stays a plain object. Other properties of the thrown value are not kept. Use `assertJsonSerializable` and `assertAgentLogEntry` at custom transport boundaries.

## Record a log

`runAgent` returns a complete, self-contained segment as `result.events`. Two ways to get it into storage:

|                | `store`                                                                                                  | `onEvent`                                 |
| -------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| When it writes | Write-ahead: every entry is appended to the store, and pending writes are awaited before each model call | Synchronously, as the entry is accepted   |
| Waits          | The result resolves only after the run's writes land                                                     | Never awaited                             |
| On failure     | The run stops: `{ status: "error", cause: "journal" }`                                                   | Nothing; the host owns it                 |
| Guarantee      | Append-before-execute                                                                                    | At-least-once, if the host persists there |

### `store`: write-ahead

Pass a [store](#stores) and the thread to write to. The run reads that thread as its resume log and appends to it.

```ts no-check
const result = await runAgent(machine, { store, threadId: "session-1", executors, input });
```

- Each entry is written at its own `index` as `expectedIndex`, so a concurrent writer conflicts instead of interleaving.
- No model call starts until every entry before it is durable. Pure transitions never wait.
- A rejected write (an `AgentEventLogConflictError`, or any storage failure) aborts in-flight work and settles the run `{ status: "error", cause: "journal" }`. No further calls run.
- A `@agent.usage` entry that arrives after the run settled is still written, but the result does not wait for it. Await `result.drain()` before terminating the process if you care about those straggler entries; it resolves once every write issued so far has landed, and never rejects (a failed write already settled the run with `cause: "journal"`).
- `threadId` is required with a `store`; without it `runAgent` throws `AgentError` with code `missing-thread-id`.
- A thread that already has entries is resumed. `input` that differs from the input the thread started with throws `AgentError` with code `thread-input-mismatch`, since two runs sharing a thread id would otherwise get one result.
- If an entry cannot be written (an `input` or event that is not JSON), the run settles `{ status: "error", cause: "journal" }` instead of running without a log. Without a store, the log stops at that entry with a `console.warn`, and the run goes on.
- Passing `events` as well makes that log the resume, and it must BE the thread's log: a different length throws `AgentEventLogConflictError`, and an entry-for-entry mismatch at the same length throws `AgentError` with code `event-log-conflict`.

### `onEvent`: observer

`onEvent` fires once per newly accepted entry, init entry first. It is synchronous and never awaited: it observes an entry after XState accepted it and cannot hold up the transition. Persisting there is at-least-once, not append-before-execute.

```ts no-check
const appended: AgentLogEntry[] = [];

const result = await runAgent(machine, {
  executors,
  onEvent: (entry) => appended.push(entry),
  input,
});
```

### `recordLog`: a plain actor

A plain `createActor` run has no runtime to journal it. `recordLog(actor)` records it as the same entries: the init entry, then every event the root machine processed, with invoke outputs inline. Attach it before `actor.start()`. Attaching to a finished actor throws, and reading `entries` before an init entry exists (not started yet, or attached after start) throws `AgentEventLogError` rather than returning a partial log.

```ts
import { createActor, createAsyncLogic, createMachine, toPromise } from "xstate";
import { recordLog, replay } from "@statelyai/agent/log";
import { z } from "zod";

const orderMachine = createMachine({
  schemas: { input: z.object({ orderId: z.string() }) },
  context: ({ input }) => ({ orderId: input.orderId, total: 0 }),
  initial: "idle",
  states: {
    idle: { on: { LOOKUP: { target: "lookingUp" } } },
    lookingUp: {
      invoke: {
        src: createAsyncLogic({ run: async () => 42 }),
        onDone: ({ context, event }) => ({
          target: "found",
          context: { ...context, total: event.output as number },
        }),
      },
    },
    found: { type: "final" },
  },
});

const actor = createActor(orderMachine, { input: { orderId: "o1" } });
const log = recordLog(actor);
actor.start();
actor.send({ type: "LOOKUP" });
await toPromise(actor);
log.stop();

log.entries.map((entry) => entry.event.type);
// ["@agent.init", "LOOKUP", "xstate.done.actor"]

const { snapshot } = replay(orderMachine, log.entries);
// snapshot.value === "found", snapshot.context.total === 42; the lookup did not run again
```

- An actor created from a `snapshot` starts its log from that snapshot.
- Each entry carries `verification.stateHash`, so `replay` verifies the fold.
- Attached after `start()`, it misses the init event, and reading `log.entries` throws `AgentEventLogError`. An event that cannot be journaled (a payload that is not JSON) stops the recording the same way.

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

| `verify`         | Behavior                                                    |
| ---------------- | ----------------------------------------------------------- |
| `true` (default) | Checks entries that carry a hash; entries without one pass. |
| `'strict'`       | Requires a hash on every entry.                             |
| `false`          | No checks.                                                  |

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
- Replay against the machine the runtime folded. When actors come in through `createAgentRuntime(machine, { actors })`, call `replay(machine.provide({ actors }), entries)`. The executor-bound machine is never needed; recorded results replace executors.
- A run whose initial state cannot be serialized to JSON produces no log: `result.events` is empty, `onEvent` never fires, and nothing is written to a `store`. `replay` rejects a log without an init entry, so `runAgent` journals nothing rather than a suffix.
- `onEvent` alone does not make a call append-before-execute. A crash between an entry and the host's flush loses it. Use `store` when that matters.

## Fork

`forkEventLog(entries, upToIndex)` returns the prefix `[0, upToIndex)` as a new, still self-contained log. `upToIndex` is exclusive and must leave the init entry in place.

- The fork is its own lineage. Its init entry gets a fresh `metadata.executionId` and `metadata.forkedFrom: { executionId?, logIndex }`: the cutoff, and the parent's id when the parent's init entry has one. Every other entry is copied as is.
- Call keys derive from the execution id, so a call the fork makes never shares an `info.callKey` with one its parent makes at the same site.
- A snapshot of the parent does not take the fork's fast path. Resuming the fork with one folds its log instead.
- A version bridge accepts the parent's snapshot while the fork has appended nothing since its cutoff, since the fork's log is then the parent's. After the fork appends, bridge it with its own snapshot.
- Passing the parent's log as `events` for the fork's `threadId` is refused (`event-log-conflict`): the init entries name different lineages.

```ts no-check
const branch = forkEventLog(entries, 8);
```

`store.fork({ threadId, newThreadId, upToIndex })` does the same at the storage layer. To diverge, append different entries to the new thread. A store you write stores what `forkEventLog` returns for the prefix; the conformance suite checks it.

## Decision attempts

A decider can need several tries: a choice the guard rejects, an option that was never offered, an unknown type, an invalid payload. Those failed attempts are what you improve a decider from, and the machine never consumed them, so they ride on the entry they explain:

- An `agent.decide` invoke that lands after failed tries records them on the delivered event's entry as `entry.attempts`.
- A decision that exhausts its retries records its `xstate.error.actor` entry with `event.error.code: "decision-exhausted"` and `event.error.attempts`. `getDecisionAttempts` reads `attempts` only from an error with that code.
- A first-try decision records nothing.

Neither changes the fold: replay reads only `entry.event`, and the same log with the fields removed replays to the same state hash. Old logs without them replay unchanged, and `schemaVersion` stays `1`.

`getDecisionAttempts(entries)` lists both, in log order:

```ts no-check
for (const { index, eventType, attempts } of getDecisionAttempts(await store.read(threadId))) {
  console.log(
    index,
    eventType,
    attempts.map((attempt) => attempt.reason),
  );
}
```

`eventType` is the delivered event's type, or an `xstate.error.actor.*` type for an exhausted decision.

### Boundary decisions

A host that decides with `decideNext` sends the event itself. Pass its `attempts` alongside the event, and the run journals them on that event's entry:

```ts no-check
const { event, attempts } = await decideNext(snapshot, { decide, model, allowedEvents: "desk.*" });

if (event) {
  await runAgent(machine, { store, threadId, event, attempts });
}
```

- `runAgent(machine, { event, attempts })` takes the same pair. `attempts` explain the opening `event` only, not an `onIdle` answer.
- A host-owned loop passes the same option to `runtime.transition(state, event, { attempts })`.
- An empty `attempts` list records nothing.
- Non-JSON `attempts` throw `NonSerializableAgentEventError` before the machine moves.

## Usage totals

`getUsageFromEvents(entries)` folds the `@agent.usage` entries into one cumulative total. The log is the source of truth, so the totals are a projection of it rather than a host-side accumulator. See [Usage and budgets](usage-and-budgets.md).

## Stores

`AgentEventLogStore` is the one interface a host implements. It is append-only, with optimistic concurrency on log length.

```ts no-check
const store = createInMemoryEventLogStore();

await store.append({
  threadId: "session-1",
  expectedIndex: 0,
  entries: [initEntry(machine, { input })],
});

const recent = await store.read("session-1", { from: 3 });
const next = await store.length("session-1"); // the next expectedIndex
```

- `append` is atomic. A stale writer fails with `AgentEventLogConflictError`, carrying `threadId`, `expectedIndex`, and `actualIndex`, so two hosts resuming one thread resolve to exactly one winner. Entry indices must be contiguous from `expectedIndex`, and ids unique within the thread.
- `createAgentRuntime(machine, { store, threadId })` drives all three: `read` to resume, `append` per entry, `read` again to check an explicit `events` log against the thread.
- `read` and `length` are the per-thread reads. Everything else about a thread is derived from its entries.
- `fork` copies a prefix onto a fresh thread, with the fork's own lineage on its init entry (see [Fork](#fork)).
- `listThreads` is optional: it lists the threads that hold at least one entry, so a caller need not record thread ids itself.

```ts no-check
let cursor: string | undefined;
do {
  const page = await store.listThreads!({ prefix: "refunds:", limit: 100, cursor });
  for (const threadId of page.threadIds) await improve(await store.read(threadId));
  cursor = page.cursor;
} while (cursor !== undefined);
```

- `prefix` filters thread ids; `limit` caps one page; `cursor` continues after the previous page.
- `cursor` is opaque and present only when more ids remain. The order is stable across pages.
- `createInMemoryEventLogStore()` implements it. A custom store may leave it out.

`createInMemoryEventLogStore()` is the reference implementation. No SQLite or database store ships with the package: hosts own durability. An append-only table with a `(thread_id, index)` primary key maps onto any database.

## Store conformance

```ts no-check
await assertEventLogStoreConformance(() => createMyStore(), { describe, it });
```

The suite runs a host-written store against the reference on races, isolation, ordering, and fork semantics, plus `listThreads` paging when the store implements it. It drives any test runner, or a plain script.

## Related

- [Persistence](persistence.md): persisting the log, snapshot-as-cache, and the version bridge.
- [Hosts and executors](hosts.md): idempotency keys for at-least-once execution.
- [Observability](observability.md): traces alongside the log.
