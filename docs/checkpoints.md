---
title: The event log
description: Append events, replay deterministically. Threads, history, forking, and time travel as log operations.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

## The model

A machine's durable state is not a snapshot. It is the ordered array of **external inputs** it has received: effect completions (done/error, outputs inline), user-sent events, timer firings. Because transitions are pure, folding that array through the machine reconstructs the exact snapshot — including which effects were started and which are still owed. The log is the source of truth; everything else is derived.

Journal rule: **external inputs only.** Never journal raised/internal events — replay re-derives them, and journaling them would double-apply. Concurrency is captured, not re-run: the journaled completion order is the serialization, so replay is deterministic even when the live run raced.

This puts one obligation on machine authors: transitions and effect inputs (prompt builders, spawn inputs) must be pure functions of state and event. No `Date.now()`, no `Math.random()` inside transition code — inject time and randomness as events or input.

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

- `append` is atomic and rejects stale writers with `AgentEventLogConflictError` (`threadId`, `expectedIndex`, `actualLength`), so two hosts resuming one thread resolve to exactly one winner.
- `read`/`length` are the whole history API: the log *is* the history.
- `fork({ threadId, newThreadId, upToIndex })` copies a prefix onto a new thread. Rewind and diverge — LangGraph's time travel — is `fork` at an earlier index plus different events appended. See [examples/time-travel](../examples/time-travel/index.ts).

Every entry carries optional host-owned `metadata`, stored verbatim.

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
