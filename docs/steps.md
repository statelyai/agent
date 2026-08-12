---
title: The step path
description: Drive an agent machine one external input at a time over an append-only event log, so a durable host can crash and resume by replay.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

This page describes the step path, the low-level way to drive an agent machine when your host owns the loop and persists between model calls.

## Step path use cases

Most hosts should use [`runAgent`](hosts.md). The step path is the alternative for durable hosts that own the loop.

The **step path** is not a separate entry point. It is a set of root exports from `@statelyai/agent`, including `getAgentEffects`, `executeAgentRequest`, `resolveDecision`, `replay`, `initEntry`, and `createReplayEntry`. Use it in these cases:

- Durable execution hosts. The step path targets engines such as Cloudflare Workflows or Temporal, and any queue-driven or serverless host that must resume from the last completed step. No integration for a specific engine ships today, so you wire the loop yourself.
- One invocation per turn. A serverless function runs one frontier, persists the log, and returns.

For a live, in-process run, use [`runAgent`](hosts.md) instead. It owns an actor and settles `done`, `idle`, or `error`. The step path drives the same machine by hand, so a crashed process resumes without repeating model calls that already completed.

## The loop in six moves

The step path assumes the durability model described in [The event log](event-log.md#the-model): the log is the source of truth, only external inputs are recorded, transitions are deterministic, and concurrency is handled by serializing appends. The loop has six moves.

1. Start a log with `initEntry(machine, input)`. The reserved `@agent.init` first envelope carries the machine input, identity, timestamp, and verification hashes.
2. Call `initialTransition(machine, input)` to get the first `{ snapshot, actions }`.
3. Call `getAgentEffects(machine, snapshot, actions, { history })` to lower the frontier into an ordered `AgentEffect[]`.
4. Execute one async effect and append its completion event to the log. Run `execute` effects inline, because they produce no entry.
5. Call `transition(machine, snapshot, event)` to fold the completion back in.
6. Repeat while `snapshot.status === "active"`. If no async effect is owed, the machine is idle. Persist the log and resume later.

<!-- viz: the six-move loop as a flow: initEntry -> initialTransition -> getAgentEffects -> execute one effect -> append entry -> transition -> loop back, with an idle exit branch when no async effect is owed -->

## Loop wiring

The following wiring comes from [examples/ai-sdk-game-host/index.ts](../examples/ai-sdk-game-host/index.ts), the reference example for this path. The host defines one function that resolves a single frontier effect into the event to append, or returns `undefined` for a fire-and-forget action.

```ts no-check
import { initialTransition, transition, type AnyMachineSnapshot, type EventObject } from "xstate";
import {
  createReplayEntry,
  executeAgentRequest,
  getAgentEffects,
  initEntry,
  resolveDecision,
  type AgentEffect,
  type AgentRequestExecutors,
} from "@statelyai/agent";
import { gameActors, gameMachine, gameSchemas } from "../game-agent/index.js";

async function resolveEffect(
  effect: AgentEffect,
  snapshot: AnyMachineSnapshot,
  executors: AgentRequestExecutors,
): Promise<EventObject | undefined> {
  // `execute`: a fire-and-forget action. Run it now; never recorded.
  if (effect.kind === "execute") {
    effect.exec();
    return undefined;
  }
  // `text`: resolve with the model, append the done event. The effect carries
  // its authored `mode`; `executeAgentRequest` dispatches to
  // `generateText`/`streamText` accordingly.
  if (effect.kind === "text") {
    const { output } = await executeAgentRequest(effect, executors);
    return effect.toDoneEvent(output);
  }
  // `decision`: pick a legal event (guard-gated by snapshot.can), append it directly.
  if (effect.kind === "decision") {
    return resolveDecision(effect.request, executors, {
      canTake: (event) => snapshot.can(event as never),
    });
  }
  throw new Error(`This host does not handle '${effect.kind}' effects.`);
}

async function runTurn(input: unknown, executors: AgentRequestExecutors) {
  const options = { schemas: gameSchemas, actors: gameActors };
  const entries = [initEntry(gameMachine, input)];
  let [snapshot, actions] = initialTransition(gameMachine, input);

  while (snapshot.status === "active") {
    const effects = getAgentEffects(gameMachine, snapshot as AnyMachineSnapshot, actions, {
      history: entries,
      ...options,
    });

    // Resolve one async effect into the event to append; run execute effects inline.
    let next: EventObject | undefined;
    for (const effect of effects) {
      const event = await resolveEffect(effect, snapshot as AnyMachineSnapshot, executors);
      if (event) {
        next = event;
        break;
      }
    }
    if (!next) {
      break; // idle: nothing async owed. Persist `entries`; resume on the next event.
    }

    entries.push(createReplayEntry(gameMachine, entries, next));
    [snapshot, actions] = transition(gameMachine, snapshot, next as never);
  }

  return snapshot.output;
}
```

The loop walks the frontier in order and stops at the first effect that produces an event. `execute` effects produce no event, so they all run inline and the walk continues past them. Once one event is produced, the loop appends it and folds it in, then derives a fresh frontier. Effects that were owed but not yet resolved are re-derived on the next pass, so nothing is lost by stopping early.

Resolve each effect according to its kind.

- `text`, from `agent.generateText` or a `createTextLogic` invoke. Resolve it with the model through `executeAgentRequest`, then append `effect.toDoneEvent(output)` or `effect.toErrorEvent(error)`.
- `decision`, from `agent.decide`. Call `resolveDecision(effect.request, executors, { canTake })` and wire `canTake` to `snapshot.can`, so guard-rejected choices are caught and retried. A decision has no output of its own. Append the chosen machine event.
- `task`, from any other invoke or spawn. Run the actor in your own runtime, then append `effect.toDoneEvent(output)` or `effect.toErrorEvent(error)`.
- `delay`, from an `after(...)` timer. The host owns the clock. Schedule the delay as a workflow sleep, a timer, or a queue delay. When it fires, append `effect.event` as a normal external entry.
- `execute`, from a fire-and-forget action such as a custom entry action, `sendTo`, or `cancel`. Call `effect.exec()` once at the frontier. These effects are never recorded and never replayed.

If a frontier produces no completion event, either because every effect is `execute` or because nothing is owed, the machine is idle and waiting on an external event or a timer. Persist `entries` and leave the loop. Resume later by appending the event and folding it in, or by calling `replay`.

For the resume-by-replay version of this loop, which persists only the event log and rebuilds the frontier with `replay` each turn, see [examples/cloudflare-workers-ai-host/index.ts](../examples/cloudflare-workers-ai-host/index.ts). That example only simulates durability, because its `entries` array lives in process memory for one run. A real Worker uses the same structure with a store such as KV, D1, or a Durable Object in place of the array.

### Token usage on this path

`executeAgentRequest` returns the raw executor result alongside the output. Use the raw result when you want a token budget in the machine. `getCallUsage(raw)` normalizes it, and you apply the reserved [`@agent.usage`](usage-and-budgets.md#the-agentusage-event) event as an ordinary event in the fold. It is journaled like any other external input, so replay reproduces the counter.

Append the usage event before the call's own done event. A budget guard then reads the new token total in the same step that consumes the output. This is the ordering `runAgent` uses.

```ts
import { AGENT_USAGE_EVENT_TYPE, executeAgentRequest, getCallUsage } from "@statelyai/agent";

if (effect.kind === "text") {
  const { output, raw } = await executeAgentRequest(effect, executors);

  const usage = getCallUsage(raw);
  if (usage) {
    append({ type: AGENT_USAGE_EVENT_TYPE, usage });
  }
  append(effect.toDoneEvent(output));
}
```

In this example, `append(event)` is the loop's own `entries.push(createReplayEntry(machine, entries, event))` followed by `transition(...)`. Add `kind`, `id`, `src`, and `model` to the event to record the attribution that `runAgent` stamps. Usage is opt-in: a machine that declares no `'@agent.usage'` transition ignores the event, so append it only when the machine declares one.

### Standalone decision resolution

`getAgentEffects` surfaces a decision effect whose request has an `events` field holding only the events that are legal from the current snapshot. That set is [`allowedEvents`](decisions.md) intersected with the XState guards. Resolve it to the chosen, validated event with `resolveDecision`, without running the whole loop.

```ts
import { getAgentEffects, resolveDecision } from "@statelyai/agent";

const effects = getAgentEffects(machine, snapshot, actions, { history: entries });
const effect = effects.find((e) => e.kind === "decision")!;

const event = await resolveDecision(effect.request, executors, {
  canTake: (candidate) => snapshot.can(candidate),
});
// { type: 'ATTACK', target: 'orc' }
```

`resolveDecision(request, executors, options)` takes the whole executor set, the same object `executeAgentRequest` takes, and uses its `decide` slot. An executor set with no `decide` function throws an `AgentError` with code `'missing-decide-executor'`. The call retries on an unknown event type, an invalid payload, or a guard rejection, up to `maxRetries` retries after the first attempt, which defaults to 2. It throws `AgentDecisionExhaustedError` when the retry budget runs out. Use `renderDecisionAttempts` to format the attempts for a log. The `snapshot.can(event)` check validates the choice at apply time. See [Decisions](decisions.md#validation-and-retries).

## Durable append before continue

On an initialized thread, treat the transition after an effect as tentative until its completion envelope commits.

The sample below uses two host-supplied pieces. `store` is any `AgentEventLogStore`, such as `createInMemoryEventLogStore()` or the SQLite store; see [the store contract](event-log.md#the-store-contract). `executeEffect` is your own version of the `resolveEffect` function shown above, returning the event to append.

<!-- viz: append-before-continue sequence: read log -> replay -> execute effect with requestId as idempotency key -> optimistic append at expectedIndex -> commit or conflict -> reload and replay the winning history -->


```ts no-check
const entries = await store.read(threadId);
const { snapshot, effects } = replay(machine, entries);
const effect = effects.find((effect) => effect.kind !== "execute");
if (!effect) throw new Error("Thread is idle");

const event = await executeEffect(effect, {
  idempotencyKey: effect.requestId,
});
const entry = createReplayEntry(machine, entries, event);

// Atomic optimistic append. A competing writer causes a conflict; discard the
// tentative result, reload, and replay the winning history.
await store.append({
  threadId,
  expectedIndex: entries.length,
  entries: [entry],
});

// Only now publish/use the new state. Replaying the committed log is simplest.
const committed = replay(machine, [...entries, entry]);
```

- The effect runs before its result can be appended, so a crash in that window causes the effect to run again on resume.
- Every owed effect has a replay-stable `requestId`. Pass it to the provider or tool as an idempotency key.
- The event store guarantees one winning control-state append. It does not guarantee exactly-once behavior from an external API.

`runAgent` cannot provide this guarantee. It owns a live XState actor, and its `onEvent` callback sees accepted transitions synchronously, so it cannot await an asynchronous store before XState advances. A future durable runner can wrap this same replay, effect, and append loop. Passing a store to today's actor-backed runner would only provide write-through recording.

## Ordering guarantee

`getAgentEffects` emits a single transition's effects in document order. An entry action, then a `spawn`, then a `sendTo` targeting that spawned child yields `execute`, `task`, `execute` in that order. The order matters, because the `sendTo` must run after the child it targets is started. Effects that are visible only on the snapshot, such as children spawned by an earlier transition that are still pending, are appended after the action-derived effects and deduped by site id.

## requestId and idempotency

Every effect except `execute` carries a `requestId` in the form `site#occurrence`. The `site` is the invoke or spawn site id. The `occurrence` is a 1-based counter derived from the event log, so re-entering a site produces `job#1`, then `job#2`. Because the counter is derived from the log, the same log yields identical `requestId` values on every replay.

Use the `requestId` as the idempotency key for at-least-once effect execution. A host runs the effect and then appends its completion, so a crash in that window re-runs the effect on resume. A downstream service that is idempotent on `requestId` removes the duplicate. Errors count as completions: an `xstate.error.actor` event with the effect's `actorId` routes to `onError` and increments the occurrence, so a retry is a new occurrence such as `#2` or `#3`, not a repeat of the same one.

## Crash recovery and resume

`replay(machine, entries)` folds an event log without executing anything and returns `{ snapshot, effects }`, the final snapshot plus the effects still owed at the frontier. Use it for crash recovery, fork resume, and time travel.

`replay` also recovers still-owed dynamic spawns. If a fan-out spawned N branches and recorded 2 of N completions before a crash, `replay` re-derives the one owed branch task with its correct `requestId`. Completing that task finishes the run the same way an uninterrupted run would. This behavior is covered in `src/effects.test.ts`.

<!-- viz: crash recovery: persisted event log -> replay -> {snapshot, owed effects}, showing a fan-out with 2 of 3 branch completions recorded and the third branch re-derived -->


```ts
import { replay } from "@statelyai/agent";

// Fresh process: rebuild the frontier from the persisted event log alone.
const { snapshot, effects } = replay(gameMachine, entries, options);
// resolve `effects`, append the completion, replay again (or fold with transition for speed).
```

The rule is: use `replay` for a cold resume, when a fresh process rebuilds the frontier from the log, and fold with `transition` inside a live loop, when you already hold the current snapshot.

`replay(machine, entries, { verify: 'strict' })` re-checks the recorded envelopes against a fresh fold. A tampered or diverged log throws `AgentReplayDivergenceError`, or `AgentReplayMachineMismatchError` when the log came from a different machine.

### Compaction

A snapshot taken mid-flight cannot carry in-flight effect state, but the event log can. Take a snapshot only at quiescent or idle points. To resume, use an idle snapshot plus the entries appended since it was taken, or replay the whole log from index 0. Both produce the same state. See [The event log](event-log.md) for the `AgentEventLogStore` protocol and the snapshot-as-compaction cache.

## Event log exclusions

`execute` effects, which cover fire-and-forget custom actions, `sendTo`, and `cancel`, run once at the frontier and are skipped on replay, because replay re-derives them. They are not durable state.

Anything that must survive a crash has to be an invoke or spawn of a registered actor source, so that it surfaces as a `text`, `decision`, or `task` effect whose completion is recorded. A side effect written as a fire-and-forget action is not recoverable. Model it as an invoke if its result must be replayed.

## Known limits

These limits are documented in `src/effects.ts`.

- Every spawn is host-executed on this path. A spawned machine surfaces as a `task` that the host runs, not as a live nested child actor. Live nested child machines are not supported yet.
- Streaming output has no log channel. A `text` effect carries its `mode` and `executeAgentRequest` dispatches to `streamText`, but chunks are a live-host concern. Only the final output lands in the log.
- `decision` effects assume the chosen event exits the invoking state. A decision whose chosen event leaves the machine in the same invoking state is not modeled here.

## Related

- [The event log](event-log.md): the durability hub. The `AgentEventLogStore` protocol, forking, and time travel.
- [Hosts and executors](hosts.md): the executor functions the loop calls at each `text` / `decision` effect.
- [Human in the loop](human-in-the-loop.md): idle states and resuming from a persisted event log.
