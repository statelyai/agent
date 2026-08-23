---
title: Choosing a run mode
description: Four ways to execute the same agent machine, what each one owns, and which to reach for.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

This page describes the four ways to execute an agent machine and how to choose between them.

## Four ways to execute one machine

<!-- public execution modes from src/index.ts, src/run.ts, src/provide-executors.ts, src/durable.ts, and src/effects.ts -->

An agent machine declares states, requests, and decisions. It does not run itself and does not call a model. A host drives it. There are four hosts to choose from:

- `runAgent` (controlled). The library owns the actor and the run loop.
- `provideExecutors` with `createActor` (uncontrolled). You own the actor and XState drives it.
- `runDurableAgent` (durable runtime). The library owns an event-sourced durable loop.
- The step path (`getAgentEffects`, `executeAgentRequest`, `replay`). You own the loop and the persistence.

The machine is the same in all four modes. The same file runs under each one, and the same tests cover it. Only the host changes.

<!-- viz: one machine feeding four hosts: runAgent (library-owned actor + loop), provideExecutors + createActor (user-owned actor), runDurableAgent (library-owned durable loop + event log), step path (user-owned loop + event log) -->


## Decision table

| Mode                    | You own                                             | The library owns                                                    | Durability                                                  | Reach for it when                                                                                                 |
| ----------------------- | --------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **`runAgent`**          | The call site and the executors                     | The actor, the run loop, request retries, usage aggregation, traces | Snapshot per settle, plus a replayable `result.events` log  | Scripts, HTTP handlers, workers, and anything with a request/response boundary                                    |
| **`provideExecutors`**  | `createActor`, the actor lifecycle, subscriptions   | Executor binding for agent sources only                             | Whatever you persist off the actor (`getPersistedSnapshot`) | A host that already owns an actor lifecycle, such as React, a Durable Object, or a long-lived process             |
| **`runDurableAgent`**   | Journal persistence and the external event boundary | The durable runtime loop, executor binding, and replay              | Event-sourced. Persist `entries`; resume with an event       | Durable request/response turns without writing the host loop                                                      |
| **Step path**           | The loop, the event log, when to persist, the clock | Pure effect derivation, request execution, replay, verification     | Event-sourced. Append before continue, resume by `replay`   | Custom durable engines and crash recovery that cannot re-bill completed model calls                               |

### Idle handling

Each mode reaches the point where the machine waits for an outside event differently:

- `runAgent` settles with status `idle` and returns a snapshot to resume from.
- `provideExecutors` does not settle. The actor stays alive in its current state until you send it an event.
- `runDurableAgent` settles with status `idle`; persist `entries` and resume with them plus an external `event`.
- On the step path, you detect idle yourself. When no asynchronous effect is owed, persist and return.

## Start with `runAgent`

`runAgent` is the default mode. It binds executors, drives the machine to a settle point, and returns `{ status, output?, snapshot, events, usage }`.

Choose another mode when one of these is true:

- The host already owns an actor and a render loop. Use the uncontrolled mode instead of running a second loop inside it.
- Each turn is a separate process invocation and the standard durable loop fits. Use `runDurableAgent`.
- You need custom persistence, scheduling, or effect execution. Use the step path.

Everything else uses `runAgent` with a persisted snapshot, including human-in-the-loop pauses that last days.

## Controlled: `runAgent`

```ts
import { runAgent } from "@statelyai/agent";

const result = await runAgent(machine, { input, executors });

if (result.status === "idle") {
  // resume later, on any process, from result.snapshot
}
```

- `runAgent` settles with status `done`, `idle`, or `error`. It stops its actor on every settle path, so you always resume from a snapshot.
- It descends into invoked child machines and rebinds executors as it goes.
- It aggregates token usage into `result.usage` and emits the trace stream through `onTrace`.
- It returns `result.events`, a JSON-safe `AgentLogEntry[]` that you can pass to `replay`.

<!-- viz: runAgent lifecycle: start/resume -> run loop (request -> executor -> transition) -> settle as done | idle | error, with snapshot + events emitted at each settle -->

### Variants of the controlled mode

Two entry points run the same engine as `runAgent` with a different call shape. They are variants of the controlled mode, not separate modes.

- `generateResult(machine, options)` resolves with the done result and throws `AgentIdleError` if the machine pauses. Use it when an idle settle is a failure for the caller.
- `createAgentActor(machine, options)` returns an actor that survives idle settles. Use it for long-lived sessions such as chat turns, sockets, or device events, where the event log, budgets, and traces persist across turns. Call `session.actor.send(event)` to re-open the cycle, and `await session.settled()` to resolve at the next quiescence.

Read more about [Hosts and executors](hosts.md).

## Uncontrolled: `provideExecutors`

```ts
import { createActor } from "xstate";
import { provideExecutors } from "@statelyai/agent";

const actor = createActor(provideExecutors(machine, executors), { input });
actor.subscribe((snapshot) => snapshot.status === "done" && console.log(snapshot.output));
actor.start();
```

- `provideExecutors` returns a machine with every agent source bound. The result is a plain XState actor.
- There is no run loop and no idle settling. The actor waits in its current state until you send it an event.
- `provideExecutors` descends into registered child machines, at any depth, and binds each with its own schemas. A child invoked as a direct object is not bound, the same as under `runAgent`.
- `agent.userInput` is left unbound. Supply it through the third argument, `{ actors }`.
- To trace an uncontrolled run, pass `onTrace` to `provideExecutors` and pass `traceTransitions(onTrace)` to the actor's `inspect` option. The two produce one merged stream.

Read more about [Use in any stack](any-stack.md#controlled-and-uncontrolled).

## Durable runtime: `runDurableAgent`

```ts
import { runDurableAgent } from "@statelyai/agent";

const first = await runDurableAgent(machine, { input, executors });
await store.save(first.entries);

const next = await runDurableAgent(machine, {
  entries: await store.load(),
  event: { type: "APPROVE" },
  executors,
});
```

- The result is `done` with `output`, or `idle` awaiting an external event.
- `entries` is the complete journal. Persist it after each call and pass it back on resume.
- Recorded invoke completions replay without re-running; work still in flight at a crash runs again.
- Use `onEntry` when the store should persist each append incrementally.
- This mode is experimental because it uses XState's experimental durable runtime.

## Owning the loop: the step path

```ts no-check
import { getAgentEffects, executeAgentRequest, createReplayEntry, replay } from "@statelyai/agent";

// resume: rebuild the frontier from the persisted log alone
const { snapshot, effects } = replay(machine, entries);

// execute one owed effect, append its completion, then fold it in
const { output } = await executeAgentRequest(effects[0], executors);
const entry = createReplayEntry(machine, entries, effects[0].toDoneEvent(output));
await store.append({ threadId, expectedIndex: entries.length, entries: [entry] });
```

- There is no actor. `getAgentEffects` lowers the current frontier into an ordered `AgentEffect[]`. You resolve one effect, append its completion, and fold it back in.
- The event log is the source of truth. `replay(machine, entries)` reconstructs the snapshot and the still-owed effects without executing anything.
- Append before you continue. An optimistic `expectedIndex` append is the commit point, so two workers on one thread resolve to exactly one winner.
- Every owed effect carries a replay-stable `requestId` that you can use as an idempotency key.
- The host owns the clock for `delay` effects and the runtime for `task` effects.
- `replay(machine, events, { verify: 'strict' })` re-checks recorded hashes, so a tampered or diverged log fails with an error.

<!-- viz: step path loop: replay(entries) -> frontier effects -> execute one -> append entry -> fold with transition -> repeat, with idle exit when nothing is owed -->

Read more about [The step path](steps.md), including per-effect handling and known limits.

## Combining modes

- No part of the machine is mode-specific. A machine written for `runAgent` runs on the step path without changes, and the reverse is also true.
- Tests do not depend on the mode. `simulateAgent` walks the step path from a script keyed by `src`, and `createScriptedExecutors` works with any host that takes executors. The same assertions cover the machine in every mode. See [Testing and verification](verify.md).
- One deployment can use several modes. An HTTP route can use `runAgent`, long-running jobs for the same machine can use the step path, and a React view can run it uncontrolled.
- Moving between modes changes only the host code around the machine.

## Related

- [Hosts and executors](hosts.md): the executor contract and the shipped AI SDK adapter.
- [Use in any stack](any-stack.md): the same machine behind Express, a Durable Object, or React.
- [The step path](steps.md): the per-model-call loop for durable hosts.
- [Where state lives](persistence.md): which artifact survives what, in every mode.
- [Human in the loop](human-in-the-loop.md): idle states and resuming with an event.
