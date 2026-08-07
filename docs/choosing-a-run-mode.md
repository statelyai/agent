---
title: Choosing a run mode
description: Three ways to execute the same agent machine, what each one owns, and which to reach for.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

## Three ways to execute one machine

An agent machine is a blueprint. It declares states, requests, and decisions; it never runs itself and never talks to a model. Something has to drive it, and there are three drivers:

- **`runAgent`** (controlled): the library owns the actor and the loop.
- **`provideExecutors` + `createActor`** (uncontrolled): you own the actor; XState drives it.
- **The step path** (`getAgentEffects` / `executeAgentRequest` / `replay`): you own the loop and the persistence.

**The machine does not change between them.** The same file runs under all three, and the same tests cover it either way. Only the host changes.

## Decision table

| Mode                   | You own                                             | The library owns                                                    | Idle handling                                                         | Durability                                                  | Reach for it when                                                                                                 |
| ---------------------- | --------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **`runAgent`**         | The call site and the executors                     | The actor, the run loop, request retries, usage aggregation, traces | Settles `idle` with a snapshot to resume from                         | Snapshot per settle, plus a replayable `result.events` log  | Default. Scripts, HTTP handlers, workers, anything with a request/response boundary                               |
| **`provideExecutors`** | `createActor`, the actor lifecycle, subscriptions   | Executor binding for agent sources only                             | None: the actor just sits in the waiting state                        | Whatever you persist off the actor (`getPersistedSnapshot`) | A host that already owns an actor lifecycle: React, a Durable Object, a long-lived process                        |
| **Step path**          | The loop, the event log, when to persist, the clock | Pure effect derivation, request execution, replay, verification     | Explicit: no async effect owed means idle, and you persist and return | Event-sourced. Append before continue, resume by `replay`   | Serverless per turn, queue-driven work, durable execution engines, crash recovery that cannot re-bill model calls |

## Start with `runAgent`

`runAgent` is the default and answers most needs. It binds executors, drives the machine to a settle point, and returns `{ status, output?, snapshot, events, usage }`.

Move off it when one of these is true:

- The host already owns an actor and a render loop, and a second loop inside it is redundant. Go **uncontrolled**.
- Each turn is a separate process invocation, or a crash between two model calls must not re-run the completed one. Go to the **step path**.

Everything else, including human-in-the-loop pauses that span days, is `runAgent` plus a persisted snapshot.

## Controlled: `runAgent`

```ts
import { runAgent } from "@statelyai/agent";

const result = await runAgent(machine, { input, executors });

if (result.status === "idle") {
  // resume later, on any process, from result.snapshot
}
```

- Settles `done` | `idle` | `error`, and stops its actor on every settle path, so resume is always by snapshot.
- Descends into invoked child machines, rebinding executors as it goes.
- Aggregates token usage into `result.usage` and emits the full trace stream through `onTrace`.
- Returns `result.events`, a JSON-safe `AgentLogEntry[]` you can hand straight to `replay`.
- `generateResult(machine, options)` is the go-straight-through variant: it resolves with the done result and throws `AgentIdleError` if the machine pauses.
- For a **long-lived session** (chat turns, sockets, device events) that keeps the event log, budgets, and traces without settling and restoring each turn, `createAgentActor` is the same engine with an actor that survives idle settles: `session.actor.send(event)` re-opens the cycle, `await session.settled()` resolves at the next quiescence.

Full surface: [Hosts and executors](hosts.md).

## Uncontrolled: `provideExecutors`

```ts
import { createActor } from "xstate";
import { provideExecutors } from "@statelyai/agent";

const actor = createActor(provideExecutors(machine, executors), { input });
actor.subscribe((snapshot) => snapshot.status === "done" && console.log(snapshot.output));
actor.start();
```

- Returns a machine with every agent source bound. From there it is a plain XState actor, nothing more.
- No run loop and **no idle settling**: the actor simply waits in its current state until you send it an event.
- **Does not descend into invoked child machines.** A child machine gets no executors unless you bind it yourself.
- `agent.userInput` is left unbound; supply it through the third argument, `{ actors }`.
- Tracing composes: pass `onTrace` to `provideExecutors` and `traceTransitions(onTrace)` to the actor's `inspect` for one merged stream.

Worked hosts: [Use in any stack](any-stack.md#controlled-and-uncontrolled).

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

- No actor at all. `getAgentEffects` lowers the current frontier into an ordered `AgentEffect[]`; you resolve one, append, and fold.
- The **event log is the source of truth**. `replay(machine, entries)` reconstructs the snapshot and the still-owed effects without executing anything.
- Append before you continue: an optimistic `expectedIndex` append is the commit point, so two workers on one thread resolve to exactly one winner.
- Every owed effect carries a replay-stable `requestId` to use as an idempotency key.
- The host owns the clock (`delay` effects) and the runtime for plain `task` effects.
- `verifyReplay` re-checks recorded hashes, so a tampered or diverged log fails loudly.

Full loop, per-effect handling, and known limits: [The step path](steps.md).

## Modes are not exclusive

- Nothing about the machine is mode-specific, so a machine authored against `runAgent` drops onto the step path unchanged, and back.
- Tests do not follow the mode. `simulateAgent` walks the pure step path from a by-`src` script and `createScriptedExecutors` feeds any executor-taking host, so the same assertions cover a machine whichever way production runs it. See [Testing and verification](verify.md).
- Modes can coexist in one deployment: an HTTP route uses `runAgent`, the same machine's long-running jobs go through the step path, and a React view runs it uncontrolled.
- Moving between modes is a host change. The cost is the code you write around the machine, never a rewrite of the machine.

## Related

- [Hosts and executors](hosts.md): the executor contract and the shipped AI SDK adapter.
- [Use in any stack](any-stack.md): the same machine behind Express, a Durable Object, or React.
- [The step path](steps.md): the per-model-call loop for durable hosts.
- [Where state lives](persistence.md): which artifact survives what, in every mode.
- [Human in the loop](human-in-the-loop.md): idle states and resuming with an event.
