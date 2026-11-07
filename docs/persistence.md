# Persistence

The [event log](event-log.md) is the durable artifact. A snapshot is a cache over it.

- The log is an ordered array of the external inputs the machine received. A run is fully reconstructed from it.
- The persisted snapshot is the machine's serialized state at one point. It lets a resume skip the fold.
- Live run state — the actor, in-flight requests, stream chunks — is derived and disposable.

## Persist the log

Hand `runToQuiescence` a [store](event-log.md#stores) and the thread it owns. Entries are written as they are accepted, and no model call runs against a log that is not yet durable.

```ts no-check
const result = await runToQuiescence(createAgentRuntime(machine, { store, threadId, executors }), {
  input,
});
```

- A rejected write stops the run: `{ status: "error", cause: "journal" }`.
- `threadId` is required whenever `store` is given.

`onEvent` remains the observer seam — synchronous, never awaited. Persisting there is at-least-once: a crash between an entry and the host's flush loses it. See [Record a log](event-log.md#record-a-log).

`result.events` is a complete, self-contained segment: its first entry is the reserved `@agent.init` entry, so it replays with no side channel.

## Resume from the log

With a `store`, the thread's log is the resume: pass no `events` and no snapshot.

```ts no-check
const resumed = await runToQuiescence(createAgentRuntime(machine, { store, threadId, executors }), {
  event: { type: "APPROVE" },
});
```

An empty thread starts fresh from `input`. Pass `events` explicitly to resume from a log the host holds itself (the store's thread length must then match it).

### Resume with an event off the wire

In a route handler the event arrives as JSON. Parse it at the boundary with `parseAgentEvent`, then pass the result as `event`:

```ts no-check
let event;
try {
  event = parseAgentEvent(machine, await request.json());
} catch (error) {
  return Response.json({ error: String(error) }, { status: 400 });
}

const result = await runToQuiescence(createAgentRuntime(machine, { store, threadId, executors }), {
  event,
});

if (result.ignored) {
  return Response.json(
    { error: `'${result.ignored.type}' does not apply right now` },
    { status: 409 },
  );
}
```

- `parseAgentEvent` takes `unknown`: hand over the parsed JSON body as-is. It accepts the machine itself (reading the event schemas `setupAgent` registered) or any snapshot of it, and returns the event typed as the machine's event union.
- It throws `AgentInvalidEventPayloadError` (code `invalid-event-payload`) when the payload is not an object with a string `type`, when the type is a reserved `@agent.*` type, or when the fields fail the registered schema. Answer that with a 400.
- On success the schema-parsed event is returned: defaults filled, transforms applied.
- `parseAgentEvent` does not check whether the current state handles the event, and `runToQuiescence` adds no validation of its own.
- An event the resumed state has no transition for is ignored. The run settles normally and `result.ignored` carries the event. It is journaled like any other external input, so replay ignores it again.

- Recorded results are replayed, never re-executed.
- A request that was in flight when the log ended has no recorded completion, so it re-executes. Execution is at-least-once; key provider calls on [`info.callKey`](hosts.md#idempotency-keys).
- A log that already reached a final state settles immediately with the recorded output.
- The resumed result's `events` extends the same log, so the whole history stays replayable.

## Crash testing

`checkCrashRecovery` from `@statelyai/agent/testing` kills a run at every point it could die and checks that the resume matches a run that never died.

```ts
import { createAsyncLogic } from "xstate";
import { z } from "zod";
import { setupAgent, createTextLogic } from "@statelyai/agent";
import { checkCrashRecovery } from "@statelyai/agent/testing";

const machine = setupAgent({
  context: z.object({ order: z.string() }),
  events: {},
  actors: {
    lookup: createAsyncLogic({ run: async () => "order-7" }),
    reply: createTextLogic({ model: "m", prompt: "Reply." }),
  },
}).createMachine({
  context: { order: "" },
  initial: "lookup",
  states: {
    lookup: {
      invoke: {
        src: "lookup",
        onDone: ({ event }) => ({ target: "reply", context: { order: event.output } }),
      },
    },
    reply: { invoke: { src: "reply", onDone: { target: "done" } } },
    done: { type: "final" },
  },
});

const report = await checkCrashRecovery(machine, {
  executors: { generateText: async () => ({ result: "Your order shipped." }) },
});
report.failures; // [] when every crash point recovers
```

It runs the machine once uninterrupted, then once per crash point, each resumed from the store's log by a fresh runtime:

- **Log points:** before the first append, and after each append. The next write never lands.
- **Effect points:** while each model call or plain actor is in flight. It ran, but its result was never recorded.

Each resumed run is checked against the uninterrupted one. Each failure names its crash point and one of these problems:

| `problem`         | Meaning                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------- |
| `reran`           | An effect ran again although its completion was durable before the crash                    |
| `skipped`         | An effect of the uninterrupted run never ran                                                |
| `unexpected`      | An effect ran that the uninterrupted run never made, such as a call under a new `callKey`   |
| `request-changed` | A model call re-executed under its `callKey` with a different request                       |
| `outcome`         | The resume ended with a different status, output, state, or context                         |
| `replay`          | The final log does not replay to the resumed state                                          |
| `undelivered`     | A `sendDuring` event the crash lost, which the resume never reached the point to send again |
| `stuck`           | The crashed run or its resume did not settle within `timeout` (default 5000 ms)             |
| `threw`           | The crashed run, its resume, or the `store` factory threw                                   |

- `report.unreached` lists the points no run died at, with why: the crashed run never started that effect, or one write took the log past that length. A point is tried 3 times before it counts, since concurrent effects can settle in another order and merge two writes. Their resumes were not checked, so `report.ok` is `false`. An effect point is the n-th run of its key, so concurrent effects starting in another order still hit it.
- An effect in flight at the crash may run twice. That is the at-least-once contract (see [Idempotency keys](hosts.md#idempotency-keys)), and it is not reported.
- Model calls are keyed by `callKey` without the execution id, and plain actors by invoke site. Only actors bound through string-keyed sources are seen.
- Model calls run live only in the uninterrupted run. After a crash, a call it made gets its recorded answer, after the same delay, so a fake may answer by call order.
- Plain actors run live every time, so they must give the same result however often they run. A fake that keeps state passes `reset`, which runs before the baseline and each crashed run. It does not run before the resume, so the fake keeps what the crashed run did, as a real dependency would.
- The outcome check compares the root's final status, output, state, and context, not spawned children's. A child's progress counts only through what it reports to the root. It compares final states, so a machine whose result depends on which concurrent call finishes first can fail it after a crash. Make the result order-independent, or test that part without concurrency.
- `events` are host events, delivered one per idle settle. A resume skips the ones its log already holds.
- `sendDuring` sends host events while the run is busy: `{ during: "draft#1", event: { type: "CANCEL" } }` goes out the first time that effect starts, keyed as in `report.baseline.effects`: `<site>#<n>` for a model call, `actor:<site>` for a plain actor. Pass `occurrence` (from 0) to target a later start of the same key, such as a retry's second POST. After a crash, one the log does not hold is sent again, as a retrying host would, as its effect starts again or, when that effect's completion was durable, at the point the uninterrupted log holds it, so it lands in the same order. A `during` key (or `occurrence`) the uninterrupted run never starts throws, so a typo cannot pass silently.
- `timers: "host"` makes the harness the host scheduler for root `after` timers (see [Host-owned timers](steps.md#host-owned-timers)). The run settles `idle` with them pending. An id-less `{ type: "xstate.timer" }` in `events` is a timer's turn: the timer due soonest fires there. Once `events` run out, the pending timers fire in due order, without waiting for their delays. Each is due its delay after it was scheduled, on a clock that advances as timers fire. The default, in-process timers, fire after their real delay.
- An uninterrupted run that ends with some of `events` undelivered throws, so an event a final state never sees cannot pass silently.
- `store` takes a factory for your own store adapter, one fresh store per run. A store that acknowledges a write it then loses shows up as `reran`.

Run it in CI next to the machine's other tests. It needs no API key.

## Snapshot as cache

`persist()` output carries `agentMeta: { machineId, version, logId, logIndex }` — the lineage and position of the log it caches.

Pass `snapshot` alongside `events` to skip the fold:

```ts no-check
const resumed = await runToQuiescence(createAgentRuntime(machine, { executors }), {
  events: await store.read(threadId),
  snapshot: await snapshots.get(threadId),
  event: { type: "APPROVE" },
});
```

- Fast path: `agentMeta.logId` names the log, `logIndex` equals the log length, and the snapshot's state hash matches the tail entry's `verification.stateHash`. Length alone is not enough — a fork or a sibling thread can sit at the same index.
- Otherwise the log is replayed and the run resumes from the replayed state.
- A cache that disagrees with the state the log replays to throws `AgentSnapshotDivergedError` (code `snapshot-diverged`). Drop the snapshot and resume from `events` alone.

A snapshot is never authoritative within a version. Snapshot only at quiescent points: a mid-flight snapshot cannot carry in-flight request state, but the log can.

Resuming from a snapshot with no log also yields a self-contained log — the new segment's init entry carries that snapshot — so every result is replayable.

## Version bridge

A log is truth within one `machine.version`. Across a version change, pass the old `events` together with a `snapshot`:

```ts no-check
const migrated = await runToQuiescence(createAgentRuntime(machine, { executors }), {
  events: oldEntries,
  snapshot: oldSnapshot,
});
```

- XState's machine-owned `migrate` runs on the snapshot.
- The result is a **new** segment. Its init entry carries the migrated snapshot and `metadata.migratedFrom`.
- The old log stays as history under the old version. Keep it if you need to replay the past.
- Old `events` with no `snapshot` throw `AgentMachineVersionMismatchError`: there is nothing to migrate from.

Declare the version and migration on the machine:

```ts no-check
const machine = setup.createMachine({
  version: "2",
  migrate: (snapshot, fromVersion) =>
    fromVersion === "1"
      ? { ...snapshot, version: "2", context: upgrade(snapshot.context) }
      : snapshot,
  // ...
});
```

## Framework storage

Implement `AgentEventLogStore` against the host's database, or append through the framework's own mechanism: a Durable Object, workflow checkpoint, or server action store. See [Stores](event-log.md#stores) and [Hosts and executors](hosts.md).

The recipe per turn is one call: `runToQuiescence` reads the thread, runs, and writes back.

```ts no-check
const result = await runToQuiescence(createAgentRuntime(machine, { store, threadId, executors }), {
  event: incoming,
});
```

The framework remains responsible for transactionality, retries, interruption recovery, and retention.
