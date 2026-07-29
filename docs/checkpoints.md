---
title: The event log
description: Append events, replay deterministically. Threads, history, forking, and time travel as log operations.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

## The model

A machine's durable state is not a snapshot. It is the ordered array of **external inputs** it has received: effect completions (done/error, outputs inline), user-sent events, timer firings. Because transitions are pure, folding that array through the machine reconstructs the exact snapshot — including which effects were started and which are still owed. The log is the source of truth; everything else is derived.

Journal rule: **external inputs only.** Never journal raised/internal events — replay re-derives them, and journaling them would double-apply. Concurrency is captured, not re-run: the journaled completion order is the serialization, so replay is deterministic even when the live run raced.

This puts one obligation on machine authors: transitions and effect inputs (prompt builders, spawn inputs) must be pure functions of state and event. No `Date.now()`, no `Math.random()` inside transition code — inject time and randomness as events or input.

## Export events from `runAgent`

<!-- RunAgentResult.events and RunAgentOptions events/onEvent from src/run-agent.ts; replay from src/effects.ts -->

Every `runAgent` result carries the external inputs it observed as a versioned `AgentLogEntry[]`. Pass it directly to `replay`:

```ts
import { replay, runAgent } from "@statelyai/agent";

const first = await runAgent(machine, { input, executors });
const { snapshot, effects } = replay(machine, first.events);
```

A fresh run starts with an envelope around `@agent.init`. The remaining entries wrap effect completions/failures, externally sent events, and timer firings. Raised events and internal transitions are absent because `replay` re-derives them.

```ts
interface AgentLogEntry {
  schemaVersion: 1;
  id: string;
  index: number;
  recordedAt: string;
  machineId: string;
  machineVersion: string;
  event: EventObject;
  causationId?: string;
  correlationId?: string;
  verification?: { stateHash: string; effectsHash: string };
  metadata?: Record<string, JsonValue>;
}
```

`recordedAt` is acceptance metadata, never semantic machine time. If a transition needs time, put it in the machine event itself. `machineVersion` is the explicit run option or the machine's structural hash. The verification hashes pin the logical state and still-owed effects after each entry.

XState v6 uses stable category event types with identity in payload fields. Preserve the whole object: an invoke completion is `{ type: "xstate.done.actor", actorId, sessionId, output }`; a timer firing is `{ type: "xstate.timer", id }`. `replay` rebinds logged actor sessions to the new actor system, so globally unique runtime IDs do not make the log machine-specific.

When resuming by snapshot, pass the preceding events back to keep one complete history:

```ts
const second = await runAgent(machine, {
  snapshot: first.snapshot,
  event: { type: "APPROVE" },
  events: first.events,
  executors,
});

replay(machine, second.events);
```

The `events` option only carries history forward; `snapshot` remains the live resume source. If omitted on a snapshot resume, the returned array contains only events observed during that invocation and is not a complete replay from initialization.

To capture the same replayable events while the run is in flight, use `onEvent`:

```ts
const events = [...previousEvents];

const result = await runAgent(machine, {
  snapshot,
  event,
  events: previousEvents,
  executors,
  onEvent: (entry) => {
    events.push(entry);
    appendToStore(entry);
  },
});
```

`onEvent` fires once per newly observed envelope, including the `@agent.init` entry on a fresh run. It does not re-emit history supplied through `events`. Unlike `onTransition`, it excludes raised and internal events, so its output can be passed directly to `replay`.

`runAgent` owns a live XState actor. Its `onEvent` callback observes an event after XState accepted it and cannot await an asynchronous store before the transition. It is useful for export/write-through recording, but is not an append-before-transition crash-safety guarantee. For that guarantee use the [pure step path](steps.md#durable-append-before-continue).

## JSON is the wire contract

`createReplayEntry`, `initEntry`, every built-in store append, and `replay` validate the complete envelope. Values that JSON would drop or coerce are rejected with `NonSerializableAgentEventError` carrying the exact `path`: `undefined`, functions, symbols, bigint, non-finite numbers, negative zero, sparse arrays, hidden properties, cycles, `Date`, `Map`, `Set`, and class instances. Framework error events normalize `Error` values to plain `{ name, message, cause? }` records before storage.

Use `assertJsonSerializable(value)` and `assertAgentLogEntry(entry)` at custom transport boundaries. This strict subset makes an exported log mean the same thing in another process or language.

## Strict replay verification

Normal `replay` checks verification hashes when present. `verifyReplay` requires them on every entry and fails at the first mismatch:

```ts
import { ReplayDivergenceError, verifyReplay } from "@statelyai/agent";

try {
  verifyReplay(machine, entries);
} catch (error) {
  if (error instanceof ReplayDivergenceError) {
    console.error(error.eventId, error.index, error.kind);
  }
}
```

`kind: "state"` means the current machine derived different logical state. `kind: "effects"` means it owed different work — for example a changed prompt, model, tool set, task input, or timer. `ReplayMachineMismatchError` rejects an envelope stamped for another machine id/version before folding it.

Structural hashing cannot see custom function bodies or schema-validator implementations. Set an explicit `machineVersion` whenever those semantics change; the per-entry hashes then verify their observable state/effect consequences.

## The store contract

`AgentEventLogStore` is an append-only protocol with optimistic concurrency on the log length:

```ts
import { createInMemoryEventLogStore } from "@statelyai/agent";

const store = createInMemoryEventLogStore();

// append at the expected position (0 = new thread); a concurrent writer
// with the same expectation loses with AgentEventLogConflictError
await store.append({ threadId: "session-1", expectedIndex: 0, entries });

// catch up incrementally
const entries = await store.read("session-1", { from: 3 });
const next = await store.length("session-1"); // the next expectedIndex
```

- `append` is atomic and rejects stale writers with `AgentEventLogConflictError` (`threadId`, `expectedIndex`, `actualLength`), so two hosts resuming one thread resolve to exactly one winner. Event ids must also be unique within a thread.
- `read`/`length` are the whole history API: the log *is* the history.
- `fork({ threadId, newThreadId, upToIndex })` copies an exclusive index prefix; `atEventId` is the inclusive event-id form. Forked entries retain their ids. Rewind and diverge by appending different envelopes to the new thread.

Every entry carries optional host-owned `metadata`, stored verbatim.

## Fork and diff

```ts
import { diffEventLogs } from "@statelyai/agent";

await store.fork({
  threadId: "session-1",
  newThreadId: "candidate",
  atEventId: "evt_00000007",
});

const diff = diffEventLogs(
  machine,
  await store.read("session-1"),
  await store.read("candidate"),
);
```

`diffEventLogs` returns the exact common prefix, parent-only and fork-only tails, both replay results, JSON Patch-style logical-state changes, and added/removed/changed frontier effects. It is structural only; semantic quality belongs to an evaluator.

## Conform your own store

`createInMemoryEventLogStore()` is the reference implementation and the conformance baseline. An append-only log with a unique `(threadId, index)` constraint is a natural fit for any database; prove yours matches the reference — races, isolation, ordering, fork semantics:

```ts
import { assertEventLogStoreConformance } from "@statelyai/agent";

await assertEventLogStoreConformance(() => createMyStore());
```

Each assertion throws a descriptive `Error` on the first violation, so any runner (or a plain script) can drive it.

## Snapshots are compaction, not truth

[`AgentSnapshotStore`](human-in-the-loop.md) remains useful as an **idle-point cache**: at a quiescent point (an idle state with no in-flight effects), persist the snapshot and resume from it plus the events appended since, instead of replaying from index 0. Compact only at quiescent points — a snapshot taken mid-flight cannot carry in-flight effect state; the log can.

## Related

- [The step path](steps.md): driving a machine one external input at a time.
- [Human in the loop](human-in-the-loop.md): idle states — the natural compaction points.
