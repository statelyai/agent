---
title: The step path
description: Drive an agent machine one external input at a time over an append-only event log, so a durable host can crash and resume by replay.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

## When to use the step path

The **step path** is not a separate entry point. It is a set of root exports from `@statelyai/agent` (`getAgentEffects`, `executeAgentRequest`, `resolveDecision`, `replay`, `initEntry`, `createReplayEntry`, ...) for hosts that own the loop and persist between model calls:

- **Durable execution hosts:** designed for engines like Cloudflare Workflows or Temporal, and for any queue-driven or serverless-per-turn host that must resume from the last completed step. No integration for a specific engine ships today; you wire the loop yourself.
- **One invocation per turn:** a serverless function that runs one frontier, persists, and returns.

For a live, in-process run, use [`runAgent`](hosts.md) instead: it owns an actor and settles `done | idle | error`. The step path is the same machine driven by hand, so a crashed process resumes without re-billing model calls.

## The model

A machine's durable state is not a snapshot. It is the ordered **event log** of external inputs it has received. Because transitions are pure, folding that log through xstate reconstructs the exact snapshot, including which effects are still owed. The log is the source of truth; the snapshot is derived.

The loop is six moves:

1. Start a log with `initEntry(machine, input)` (the reserved `@agent.init` first envelope carries the machine input, identity, timestamp, and verification hashes).
2. `initialTransition(machine, input)` gives the first `{ snapshot, actions }`.
3. `getAgentEffects(machine, snapshot, actions, { history })` lowers the frontier into an ordered `AgentEffect[]`.
4. Execute one async effect and append its completion event to the log (run `execute` effects inline; they produce no entry).
5. `transition(machine, snapshot, event)` folds the completion back in.
6. Repeat while `snapshot.status === "active"`. No async effect owed means **idle**: persist the log and resume later.

**Log rule: external inputs only.** The event log holds effect completions (done/error, with the output inline), user-sent events, and timer firings. Never append raised or internal events: replay re-derives them from the machine's own logic, and recording them would double-apply.

**Determinism obligation.** Replay re-runs your transitions, so they must be pure functions of state and event. No `Date.now()`, no `Math.random()` inside transition code or effect-input builders (prompt builders, spawn inputs). Inject time and randomness as events or input.

**Concurrency is serialization.** When parallel regions race, the recorded completion **order** is the serialization. Replay folds completions in that recorded order, so it never re-races: a run that raced live reconstructs identically.

## The loop

Taught from [examples/ai-sdk-game-host/index.ts](../examples/ai-sdk-game-host/index.ts), the canonical thin loop. One host-owned primitive resolves a single frontier effect into the event to append (or `undefined` for a fire-and-forget action):

```ts
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
    const output = await executeAgentRequest(effect, executors);
    return effect.toDoneEvent(output);
  }
  // `decision`: pick a legal event (guard-gated by snapshot.can), append it directly.
  if (effect.kind === "decision") {
    return resolveDecision(effect.request, executors.decide!, {
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

Per-effect resolution, by kind:

- **`text`** (`agent.generateText` / a `createTextLogic` invoke): resolve with the model via `executeAgentRequest`, then append `effect.toDoneEvent(output)` (or `effect.toErrorEvent(error)`).
- **`decision`** (`agent.decide`): `resolveDecision(effect.request, decide, { canTake })`, wiring `canTake` to `snapshot.can` so guard-rejected choices are caught and retried. A decision has no output of its own; the chosen machine event is what you append.
- **`task`** (any other invoke or spawn): a plain host-run actor. Run it in your own runtime, then append `effect.toDoneEvent(output)` / `effect.toErrorEvent(error)`.
- **`delay`** (an `after(...)` timer): the host owns the clock. Schedule the delay (a workflow sleep, a timer, a queue delay); when it fires, append `effect.event` as a normal external entry.
- **`execute`** (a fire-and-forget action: a custom entry action, `sendTo`, `cancel`): run `effect.exec()` once at the frontier. Never recorded, never replayed.

**Idle.** A frontier that produces no completion event (all `execute`, or nothing owed) means the machine is waiting on an external event or a timer. Persist `entries` and leave the loop; resume later by appending the event and folding it in (or by `replay`).

For the durable, resume-by-replay flavor of this same loop (persist nothing but the event log, rebuild the frontier with `replay` each turn), see [examples/cloudflare-workers-ai-host/index.ts](../examples/cloudflare-workers-ai-host/index.ts). That example simulates durability: its `entries` array lives in process memory for the duration of one run. It shows the shape a real Worker would use, with a real store (KV, D1, a Durable Object) in place of the array.

### Token usage on this path

The loop above throws the raw executor result away. Ask for it (`{ verbose: true }`) when you want a token budget in the machine: `getCallUsage(raw)` normalizes it, and the reserved [`@agent.usage`](usage-and-budgets.md#the-agentusage-event) event is applied as an ordinary event in the fold — journaled like any other external input, so replay reproduces the counter.

```ts
import { AGENT_USAGE_EVENT_TYPE, executeAgentRequest, getCallUsage } from "@statelyai/agent";

if (effect.kind === "text") {
  const { output, raw } = await executeAgentRequest(effect, executors, { verbose: true });

  // Apply usage BEFORE the call's own result, so a budget guard reads the
  // tokens in the same step that consumes the output (runAgent's ordering).
  const usage = getCallUsage(raw);
  if (usage) {
    append({ type: AGENT_USAGE_EVENT_TYPE, usage });
  }
  append(effect.toDoneEvent(output));
}
```

Where `append(event)` is the loop's own `entries.push(createReplayEntry(machine, entries, event))` plus `transition(...)`. Add `kind`/`id`/`src`/`model` to the event for the attribution `runAgent` stamps. Same opt-in rule as everywhere: a machine that declares no `'@agent.usage'` transition takes nothing, so only append it when the machine declares one.

### Resolving decisions standalone

`getAgentEffects` surfaces a decision effect whose request's `events` field holds only the events legal from the current snapshot ([`allowedEvents`](decisions.md) intersected with XState guards). Resolve it to the chosen, validated event with `resolveDecision`, without running the whole loop:

```ts
import { getAgentEffects, resolveDecision } from "@statelyai/agent";

const effects = getAgentEffects(machine, snapshot, actions, { history });
const effect = effects.find((e) => e.kind === "decision");

const event = await resolveDecision(effect.request, decide, {
  canTake: (candidate) => snapshot.can(candidate),
});
// { type: 'ATTACK', target: 'orc' }
```

`resolveDecision` retries on an unknown event type, an invalid payload, or a guard rejection, and throws `AgentDecisionExhaustedError` when the retry budget runs out (`renderDecisionAttempts` formats the attempts for a log). Its `snapshot.can(event)` check closes the gap at apply time. See [Decisions](decisions.md#validation-and-retries).

## Durable append before continue

For an initialized thread, treat the transition after an effect as tentative until its completion envelope commits:

```ts
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

The effect must run before its result can be appended, so a crash in that narrow window can retry it. Every owed effect has a replay-stable `requestId`; pass it to the provider/tool as an idempotency key. The event store guarantees one winning control-state append, not exactly-once behavior from an arbitrary external API.

This pure driver is the strict durability path. `runAgent` owns a live XState actor; its `onEvent` sees accepted transitions synchronously and cannot await an asynchronous store before XState advances. A future durable runner can wrap this exact replay/effect/append loop, but passing a store to today's actor-backed runner would only provide write-through recording, not the same guarantee.

## Ordering guarantee

`getAgentEffects` emits a single transition's effects in **document order**. An entry action, then a `spawn`, then a `sendTo` to that spawned child yields `execute`, `task`, `execute` in that order, never a reordered set. This is load-bearing: the `sendTo` must run after the child it targets is started. Effects visible only on the snapshot (a re-surfacing `agent.plan`, children spawned by an earlier transition still pending) append after the action-derived effects, deduped by site id.

## requestId and idempotency

Every non-`execute` effect carries a `requestId` of the form `site#occurrence`: the invoke/spawn site id, then a **1-based occurrence** derived from the event log (`job#1`, `job#2` on re-entry). Because it is derived from the log, the same log yields identical requestIds on every replay.

Use it as the **idempotency key** for at-least-once effect execution. A host runs the effect, then appends its completion; a crash in that window re-runs the effect on resume. An idempotent downstream (keyed by `requestId`) closes the gap. Errors count as completions: `xstate.error.actor` with the effect's `actorId` routes `onError` and increments the occurrence, so a retry is a fresh occurrence (`#2`, `#3`, …), not a re-run of the same one.

## Crash recovery and resume

`replay(machine, entries)` folds an event log without executing anything and returns `{ snapshot, effects }`: the final snapshot plus the effects still owed at the frontier. This is crash recovery, fork resume, and time travel in one call.

Still-owed **dynamic spawns** are recovered too. A fan-out that spawned N branches and recorded 2 of N completions before a crash: `replay` re-derives the one owed branch task (with its correct `requestId`), so completing it finishes the run identically to the uninterrupted path (pinned in `src/effects.test.ts`).

```ts
import { replay } from "@statelyai/agent";

// Fresh process: rebuild the frontier from the persisted event log alone.
const { snapshot, effects } = replay(gameMachine, entries, options);
// resolve `effects`, append the completion, replay again (or fold with transition for speed).
```

`verifyReplay(machine, entries)` re-checks the recorded envelopes against a fresh fold, so a tampered or diverged log fails loudly (`AgentReplayDivergenceError`, or `AgentReplayMachineMismatchError` when the log came from a different machine).

**Compaction.** A snapshot taken mid-flight cannot carry in-flight effect state; the event log can. So snapshot only at **quiescent / idle** points. Resume from an idle snapshot plus the entries appended since, or replay the whole log from index 0. Both yield the identical state. See [The event log](event-log.md) for the `AgentEventLogStore` protocol and the snapshot-as-compaction cache.

## Plans

An [`agent.plan`](plans.md) invoke applies an ordered sequence of legal events (each a decision), not one. On the step path it surfaces as a `kind: 'plan'` effect that **re-surfaces on every frontier** while the plan is in flight, its candidates recomputed from the live snapshot.

Per frontier, the host resolves **one** decision from `request.events` (via `resolveDecision`, wiring `canTake` to `snapshot.can`, plus the reserved done move and any `stopOn` events) and appends the chosen machine event. The next frontier re-surfaces the plan effect. The plan **completes** on the reserved `agent.plan.done` move (`PLAN_DONE_EVENT_TYPE`), a `stopOn` event, an exhausted `maxSteps` budget, or no legal events. Completion is recorded as `xstate.done.actor` carrying the invoke's `actorId`, `sessionId`, and `{ steps, stopped }` output, which fires its `onDone`.

The re-surfaced effect's own `applied` / `stepsRemaining` are **not** folded under pure replay (the thin loop records bare machine events, not the invoke child's ledger mutations), so the host **derives the applied trail from the event log itself**. A single applied event that exits the invoking state cancels the invoke (`onDone` never fires), identical to `runAgent`. The full host-side plan driver, and parity with `runAgent` across all four stop reasons, is pinned in `src/steps-plan.test.ts`.

## What the event log does not cover

`execute` effects (fire-and-forget custom actions, `sendTo`, `cancel`) run once at the frontier and are **skipped on replay** (replay re-derives them). They are not durable state.

Anything that must survive a crash has to be an **invoke or spawn of a registered actor source**, so it surfaces as a `text` / `decision` / `plan` / `task` effect whose completion is recorded (the completion-event rule). A side effect written as a plain fire-and-forget action is not recoverable; model it as an invoke if its result must be replayed.

## Known limits

Stated plainly (see `src/effects.ts`):

- **Every spawn is host-executed on this path.** A spawned machine surfaces as a `task` the host runs, not a live nested child actor. No live nested child machines yet.
- **Streaming output has no log channel.** A `text` effect carries its `mode` and `executeAgentRequest` dispatches to `streamText`, but chunks are a live-host concern; only the final output lands in the log.
- **`decision` effects assume the chosen event exits the invoking state.** A decision whose chosen event keeps the machine in the same invoking state is not modeled here.

## Related

- [The event log](event-log.md): the durability hub. The `AgentEventLogStore` protocol, forking, and time travel.
- [Hosts and executors](hosts.md): the executor functions the loop calls at each `text` / `decision` effect.
- [Human in the loop](human-in-the-loop.md): idle states and resuming from a persisted event log.
