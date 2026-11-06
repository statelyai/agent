---
name: build-machine
description: Build a new @statelyai/agent machine in TypeScript from a product spec and prove its invariants. Use when asked to build an agent from scratch whose rules need thresholds, counters, caps, spawned fan-out, timers, or any-time events (cancel, takeover, interrupt) — anything the JSON config's truthy-only guards cannot express — and when asked to prove a spec's invariants with canReach or explorePaths.
---

# Build an agent machine

The spec's invariants become structure, then proofs. A rule that lives in a prompt is not an invariant.

```
invariants → machine → scenario tests → proofs → crash/resume → inspector → hand back
```

Use `generate-machine` instead when the whole spec fits a JSON `AgentWorkflowConfig`: truthy guards, no counters, no spawn.

## 1. List the invariants

Write each spec rule as one sentence a search can falsify: "`book_table` never runs without a `CONFIRM` for its key", "at most 8 model turns". Ask the user for thresholds and caps you cannot read from the spec; decide the mechanics yourself.

## 2. Make each one structural

| Rule shape | Structure |
| --- | --- |
| Needs approval first | A waiting state the effect state is entered only from, on the approval event |
| A cap (turns, retries, rejections) | A counter in `context`, checked inline in the transition that would exceed it |
| A threshold (confidence ≥ 0.8) | An inline guard in the transition function |
| Any time (cancel, takeover, interrupt) | A root-level `on` handler targeting a final state, or a state-scoped `on` in every state that must accept it |
| Wait for all parallel work | Children (`enq.spawn` or parallel invokes) plus a join that counts settled results |
| Timeout / SLA | An `after` transition |
| Token budget | A root `on: { '@agent.usage': … }` fold plus a guard |

- Write guards inline and keep targets in the transition function, so `describeMachine` can read them.
- Pass `events` to `setupAgent`, even `events: {}`, so built-in events (`@agent.usage`, `xstate.error.actor`) are typed.
- A state reachable only when a rule breaks (a sentinel) makes the proof one line. A `canReach` predicate works without one.

## 3. Scenario tests

At least one test per rule: the happy path, then each failure mode. Fake models with scripted executors or `MockLanguageModelV3` from `ai/test`. Test runtime behavior a search cannot see: an aborted signal reaching the executor, a late model answer after a cancel.

## 4. Prove

```ts
import { canReach, explorePaths } from "@statelyai/agent/testing";

const result = await canReach(machine, (s) => s.matches("writing") && s.context.succeeded < 2, {
  outputs: { plan: [twoQueries, fiveQueries], search: [hits, []] },
  errors: { search: [new Error("down")] },
  interleave: "pending",
});
expect(result).toMatchObject({ reachable: false, complete: true });
```

- **Fork everything.** List at least two outputs per src, plus `errors`. A src with one output resolves without a fork and never appears in a path.
- **Any-time rules need `interleave: "pending"`**, so events arrive while work is in flight.
- **Rules across children** need `children: "coupled"`.
- **Timers fire** as events, in any order (`timers: "ignore"` turns that off and marks the result incomplete). **Usage** is offered only for root text requests listed in `usage: { src: [{ totalTokens: 500 }] }`; usage inside child machines is test-only.
- **A machine that reads `output.messages`** needs `textOutput(result, { messages })` from `@statelyai/agent/testing` as the canned output.
- **`complete: true` or it is not a proof.** Read `unexplored` and `unexpandedEvents` when it is false. Add `payloads` for events with fields, and `dedupeBy` over the context fields guards read when the search explodes.
- **Long-lived machines never complete.** Every path ends at `maxDepth`. Report a bounded proof: `reachable: false` with only max-depth notes, at a stated depth.
- **Mutation check.** Weaken each guard in a throwaway copy and confirm the proof finds a witness. A proof that cannot fail proves nothing.
- Record each rule you could not prove and why. It stays covered by tests only.

## 5. Crash and resume

Call `checkCrashRecovery(machine, { input, events, executors })` from `@statelyai/agent/testing` for each scenario, and assert `report.failures` is `[]`. It kills the run after every log append and while every effect is in flight, resumes each from the log, and checks the resume against an uninterrupted run. See `docs/persistence.md#crash-testing`.

- Executors and fake tools must answer from the request, not call order. A fake that keeps state passes `reset`.
- A failure names the crash point and the problem (`reran`, `skipped`, `outcome`, `stuck`, …). Fix the machine or the effect, never the check.

- A completed model call never runs again. An in-flight one re-runs with the same `info.callKey`.
- A plain actor (`createAsyncLogic`) in flight at the crash re-runs. It gets no call key, so derive an idempotency key from the domain (the ticket id, the booking key) and dedupe in the effect.
- Assert the side-effect ledger, not just the final state: each effect once, same output as an uninterrupted run.

## 6. Inspect

Run one scenario with `inspect: inspector.inspect` from `@statelyai/sdk`. Each actor registers once and the root's states arrive in order, across `onIdle` passes too. The SDK's `node-relay` needs `ws` installed.

## 7. Hand back

- The invariant list, each with proved / bounded / test-only and the method.
- The commands that rerun tests, proofs, and the crash test.
- What you could not prove and why.

Then route to `add-traces` (step 2 of `graph-engineering`).
