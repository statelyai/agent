---
title: Testing and verification
description: Statically lint, simulate, and explore agent machines without any API keys or model calls.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

This page covers the APIs that check an agent machine before it runs. None of them need an API key or a model call. They all live in `@statelyai/agent/testing`.

- `lintAgentMachine` statically catches undeliverable decisions, unrebindable invoke sources, and invokes with no error path. Pass `{ throw: true }` for the throwing form.
- `assertAgentMachine` is the one-line throwing form for tests and generation loops.
- `simulateAgent` drives a deterministic scripted playthrough to a known outcome.
- `explorePaths` and `canReach` enumerate decision branches and check that a target state is reachable.

Use these APIs to check that an LLM-generated machine is legal before you run it. See [authoring from scratch](quickstart.md). You can also use them to confirm that a refactor preserved behavior, so a machine converted [from a loop](from-a-loop.md) is safe to ship.

> **Note:** Everything on this page runs on `machine.config` and deterministic transition traversal, with no provider, no network, and no keys. These checks work as ordinary unit tests in any test runner, such as vitest or jest, and as CI checks.

## Machine linting

<!-- lintAgentMachine, assertAgentMachine, and related options from src/verify.ts -->

`lintAgentMachine(machine, options?)` runs static structural checks over a built machine. It accepts machines authored in TypeScript with `setupAgent(...).createMachine(...)` and machines compiled with `setupAgent.fromConfig(...)`. It returns `AgentLintDiagnostic[]`, where each diagnostic is `{ code, severity, path, message }`. The array is empty when the machine is clean.

```ts
import { lintAgentMachine } from "@statelyai/agent/testing";
const errors = lintAgentMachine(machine).filter((d) => d.severity === "error");
if (errors.length) {
  throw new Error(errors.map((e) => `${e.path}: ${e.message}`).join("\n"));
}
```

To throw instead of returning findings, call `assertAgentMachine(machine, options?)`
or pass `{ throw: true }` to `lintAgentMachine`. Both are silent when clean and
throw `AgentLintError` on error-severity findings, with the findings on
`.diagnostics`. Add `warnings: true` to fail on warnings too. Pass `disable` to
skip checks by code.

```ts no-check
assertAgentMachine(machine, { warnings: true });
```

| Code                        | Severity | Fires when                                                                                                                                                                                                                                                      |
| --------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `decide-without-events`     | error    | A state invokes `agent.decide` but neither it nor any ancestor handles any event, so the chosen event can never be delivered.                                                                                                                                   |
| `decide-allows-human-event` | error    | A decision's literal `allowedEvents` names an event the state or an ancestor handles through a transition tagged `meta: { actor: "human" }`, so the model is never offered it. See [Events a person sends](decisions.md#events-a-person-sends).                 |
| `invoke-without-on-error`   | warning  | An invoke declares no `onError`, and neither its state nor any ancestor handles an actor error, so a rejected request or actor lands the machine in an error state with no modeled recovery. Add `onError` targeting a `failed` final state or a bounded retry. |
| `direct-object-src`         | warning  | An invoke `src` is a direct object or machine value that `runToQuiescence` cannot rebind, so it inherits no host executors.                                                                                                                                     |

## Test assertions

Every check is a plain function, so you can assert structural soundness, reachability, and scripted playthroughs directly in vitest or jest.

```ts no-check
import { assertAgentMachine, canReach, simulateAgent } from "@statelyai/agent/testing";
import { supportMachine } from "./support-machine";

test("machine is structurally sound", () => {
  assertAgentMachine(supportMachine);
});

test("escalation is reachable", async () => {
  const { reachable } = await canReach(supportMachine, "escalated", {
    input: { question: "refund?" },
  });
  expect(reachable).toBe(true);
});

test("happy path settles done", async () => {
  const result = await simulateAgent(supportMachine, {
    input: { question: "refund?" },
    script: { decisions: { "agent.decide": [{ type: "RESOLVE" }] } },
  });
  expect(result.status).toBe("done");
});
```

Guards stay in force throughout. `canReach` and `simulateAgent` traverse the same machine transitions as `runToQuiescence`, so a graph path that a guard rejects never counts as reachable. These tests pin the machine's shape as prompts and models change.

## Deterministic executors

Executors are plain functions, so a test can supply scripted executors and never touch the network. Bind them onto a logic with `.withExecutor(...)`.

```ts no-check
const machine = emailDrafter.provide({
  actors: {
    draftEmail: draftEmail.withExecutor(async ({ request }) => {
      return { result: { to: "sam@example.com", subject: "Hello", body: "Hi Sam!" } };
    }),
  },
});
```

[examples/email-drafter/agent-logic.ts](https://github.com/statelyai/agent/blob/next/examples/email-drafter/agent-logic.ts) drives a full run this way, with fixed values and no model call.

Use deterministic executors when the test should exercise the real `runToQuiescence` path with canned model output. Use [`simulateAgent`](#scripted-playthroughs) when a model-free transition playthrough is enough.

## Scripted playthroughs

`simulateAgent(machine, { input, script, maxSteps? })` runs a deterministic, model-free transition playthrough. The `script` supplies responses as FIFO queues, so runs are reproducible.

This script keys by invoke **src**, not by request name. Executors that run the real `runToQuiescence` path route by request name instead. See [Testing without a provider](evals.md#testing-without-a-provider).

- `decisions` holds the `ChosenEvent` to apply per decision, keyed by decision src, usually `agent.decide`.
- `text` holds output values for text requests, keyed by request src.
- `invokes` holds answers for scripted invokes, keyed by invoke src.
- `errors` holds failure values that reject a request instead of resolving it, keyed by the same srcs the other channels use.

A decide input with `payloads` is a closed choice. A scripted decision that matches none of the options the snapshot accepts is rejected and retried, as in a live run.

Pending work is read off the snapshot's live invoked actors, not off the last transition. A state that invokes several actors at once keeps every one of them pending until it settles, including when an invoke's `onDone` targets nothing. `simulateAgent` settles one invoke per step, in invoke-id order, and keeps going until none are left, so an `always` join that waits on all of them fires.

```ts
import { simulateAgent } from "@statelyai/agent/testing";
const { status, snapshot, trail } = await simulateAgent(machine, {
  input: { questionsRemaining: 20 },
  script: {
    decisions: { "agent.decide": [{ type: "GUESS", guess: "a cat" }] },
    events: [{ type: "GUESS_RIGHT" }, { type: "PLAY_AGAIN_NO" }],
    text: {
      classifyGuessFeedback: [{ correct: true, reasoning: "matched" }],
      classifyPlayAgain: [{ playAgain: false, reasoning: "stop" }],
    },
  },
});
// status: 'done' | 'idle' | 'exhausted'
```

`simulateAgent` returns `{ status, snapshot, trail }`. The status is one of three values:

- `'done'`: the machine reached a final state.
- `'idle'`: the machine came to rest waiting on an external event that the script does not supply.
- `'exhausted'`: the playthrough hit the `maxSteps` bound, which defaults to 100, before reaching either of the above. Raise `maxSteps` or shorten the script.

For a `'done'` run, the output is on `snapshot.output`. The snapshot is typed as the generic `AnyMachineSnapshot`, so the output needs a cast to your output type.

```ts
if (result.status === "done") {
  const output = result.snapshot.output as { correct: boolean };
}
```

> **Note:** When a script queue runs dry mid-request, `simulateAgent` throws a descriptive error naming the pending request's kind, src, and id.

### Scripted failures

A state behind an invoke's `onError` is unreachable through outputs alone. Script the failure instead. An `errors[src]` entry is consumed before that src's output queue, so the first call fails and later calls fall through to `text`, `invokes`, or `decisions` as usual.

```ts
const result = await simulateAgent(machine, {
  script: {
    errors: { parse: [{ code: "truncated" }] },
    text: { parse: [{ total: 42 }] }, // still queued: the error was taken first
  },
});
// result.snapshot.value → the target of the `parse` invoke's onError
```

A failure value is any value. An `Error` is the usual one. A plain object reaches the `onError` transition as `event.error` untouched, so a machine that branches on `event.error.code` is testable without constructing a provider's error class.

An entry keyed by a decision src, usually `agent.decide`, stands in for retry exhaustion: the decision invoke is rejected, and its `onError` observes the failure the way it observes a real `AgentDecisionExhaustedError`.

A rejection that reaches no `onError` errors the machine, as it does in a live run, and `simulateAgent` throws. It throws the scripted value itself when that value is an `Error`, and otherwise a descriptive error carrying the value on `cause`.

Each rejection is on the trail. Every `resolvedRequest` entry carries an `outcome` of `'output'` or `'error'`, and a rejected one also carries the failure value on `error`.

```ts
const [, settled] = result.trail;
settled?.resolvedRequest; // { kind: 'text', src: 'parse', id: 'parse', outcome: 'error', error: { code: 'truncated' } }
```

## Branch exploration

`explorePaths(machine, { input, maxDepth?, maxPaths?, maxNodes?, budget?, outputs?, errors?, payloads?, dedupeBy?, interleave?, children?, timers?, usage? })` enumerates decision and external-event branches without a model, and reports coverage.

- At each decision, it forks one branch per candidate event. Guard-rejected candidates count in `prunedByGuard` and are not explored.
- A decision with no candidate the snapshot takes, because its guards refuse every one or the closed choice offers nothing, exhausts as it does in a live run. That branch records `{ type: 'xstate.error.actor', actorId }` and takes the invoke's `onError`. With no `onError`, it ends in an `error` terminal.
- At an idle wait, it forks one branch per externally accepted event and per armed timer. See [Timers](#timers).
- `outputs` is a map of output lists, keyed by src: a text request's src or any other invoked actor's src. A one-element list is a canned output, reused every time that src is reached. A text request resolves with it as its `result`. A longer list forks one branch per output. See [Payloads and invoke outputs](#payloads-and-invoke-outputs).
- A src with one canned output resolves without a fork, so it does not appear in the path.
- Each `done` terminal carries the machine's `output`, so one report lists every output the search reached.
- A src with no `outputs` entry halts that branch with a `needs-output` terminal instead of throwing. The terminal's `missingSrc` names it.
- `errors` is a map of canned failures per src. A src listed there forks an extra branch where that invoke is rejected, so states behind an `onError` are explored. A decision keys on its src, usually `agent.decide`, or on its invoke id; its success branch stays the per-candidate-event fork, so the failure is explored in addition to the candidates. The failure and the candidates are sibling branches: each spends one level of `maxDepth`.
- An `errors` array forks one failing branch per element, each recording `{ type: 'xstate.error.actor', actorId, error }`. `[]` is no entry. Any other value is one failure, recorded without `error`. Wrap a single array-valued failure: `[[...]]`.
- A rejection that reaches no `onError` errors the machine, and that path ends in an `error` terminal carrying the failure value on `error`.
- Every invoke a state is still waiting on counts as work, concurrent ones included. They are settled one per branch, in invoke-id order, and a src in `errors` forks per invoke.

<!-- viz: branch exploration tree for the refund machine: deciding -> AUTO_APPROVE (pruned by guard) / NEEDS_REVIEW -> awaitingHuman -> refunded, denied -->

```ts
import { explorePaths } from "@statelyai/agent/testing";
const report = await explorePaths(refundMachine, {
  input: { request: "Refund my duplicate charge", amount: 5000 },
});
// report.terminals   → both 'refunded' and 'denied'
// report.prunedByGuard → 1 (AUTO_APPROVE guarded off for amount > 100)
// report.reachedStates → ['deciding', 'awaitingHuman', 'refunded', 'denied']
```

Exploration is bounded by three limits per search, plus a [budget](#budgets) for the whole call:

- `maxDepth`: branch points along any path. Default 8.
- `maxPaths`: terminals in the report. Default 200.
- `maxNodes`: branch points expanded in total. Default 100,000. It bounds work and memory on a loopy machine, which expands many nodes per terminal.

`report.hitPathCap` is true when `maxPaths` or `maxNodes` cut exploration short. `report.partial` is true when any cap or the budget did, and `report.complete` is true only when the report covers every path.

A src in `errors` is a branch point, and counts against `maxDepth` like a decision does. When the src has an output too, both branches are explored. When it has only an error, only the failing branch is. The failing branch records `{ type: 'xstate.error.actor', actorId }` in the path, where `actorId` is the invoke's id, and the output branch records `{ type: 'xstate.done.actor', actorId, output }`.

- For a plain invoke, `output` is the canned value: what the machine's `onDone` receives.
- For a text request, `output` is the canned value as the parsed `result`. The machine receives `{ result, messages }`.
- For a [`textOutput`](#payloads-and-invoke-outputs) envelope, `output` is its `result`.

```ts
const report = await explorePaths(machine, {
  outputs: { parse: [{ total: 42 }] },
  errors: { parse: new Error("truncated response") },
});
// report.terminals → one path per branch: the parsed state and the onError state
```

### Payloads and invoke outputs

By default, events are applied as `{ type }`. A guard that reads the payload, such as `event.amount <= 100`, rejects every such event, so its target is never explored. Supply payloads to explore it.

- `payloads` is a function of the snapshot at each branch point. It returns payloads per event type. A type with an entry forks once per payload as `{ ...payload, type }`, at decisions and idle waits alike.
- Guard-rejected variants count in `prunedByGuard`.
- A decide input's own `payloads` become that decision's branch set. An explorer `payloads` entry for the same type overrides them.
- A type with no entry is filled from its event schema. Each field that is an `enum`, `const`, `boolean`, `null`, or a union of those contributes its values, and an optional one also contributes the omitted case. Exploration forks over their product, up to 64 combinations. The schema is the agent machine's, or a plain XState machine's own `schemas.events`, and must expose JSON Schema through Standard JSON Schema, as Zod 4 does.
- A type the fill cannot enumerate is listed in `report.unexpandedEvents`: a required field with no finite domain, a product over 64, or a schema with no JSON Schema is applied as `{ type }`, and an optional field with no finite domain is left out. Add a `payloads` entry for each listed type. A type with no schema at all stays `{ type }`. It is listed too when a transition for it in the active states could read the payload: a function transition, a guard, a `matches` pattern, or a `context` mapper. An object transition with none of these cannot, so the type is not listed.
- A wait where the machine refuses every offered event is recorded as an `idle` terminal, and its event types are listed in `unexpandedEvents`. The payload table offered nothing the machine accepts there, so the search is not a proof until it does.
- An explorer `payloads` entry of `[]` for a type the wait accepts skips that type, which also lists it in `unexpandedEvents`. A decide input's `[]` is different: it withholds the type at run time too, so exploration matches the run.
- `outputs` lists every output to try per src. An empty list is a src that never settles, such as a callback bridge: its invoke stays pending and only events move the machine on. Two or more outputs fork one branch each, and an `errors` entry for the same src adds the failing branch. Each forked branch records `{ type: 'xstate.done.actor', actorId, output }` in the path.
- A src is a text request when the logic the machine runs is a text request, as in `runAgent`. A `setupAgent({ requests })` src replaced by `.provide({ actors })` with a plain actor resolves with its bare canned value.
- A text request's canned value is its `result`, with `messages: []`. Wrap it in `textOutput(result, { messages })` from `@statelyai/agent/testing` when the machine reads `output.messages`.
- `dedupeBy` projects a settled snapshot to a key. Each key is explored once, or again when reached at a shallower depth. The key must include every field a guard, choice, or `onDone` reads, or the search misses paths. Include `snapshot.timers` when a delayed `enq.raise` outlives the state that scheduled it.
- Under `dedupeBy`, `terminals` are representative paths, not every path: a revisited key is not explored again, so the paths below it appear once.

```ts
const amounts = [0, 1, 100, 100.01, 500];
const violation = await canReach(refundMachine, "illegallyIssued", {
  payloads: () => ({ ISSUE: amounts.map((amount) => ({ amount })) }),
  outputs: { lookupOrder: [{ found: true }, { found: false }] },
  errors: { lookupOrder: new Error("down") },
  dedupeBy: (snapshot) => JSON.stringify([snapshot.value, snapshot.context]),
});
// violation.reachable → false across every amount and lookup outcome
// violation.complete → true, so the false is a proof, not a cut-off search
```

```ts no-check
import { explorePaths, textOutput } from "@statelyai/agent/testing";
const report = await explorePaths(chatMachine, {
  outputs: { reply: [textOutput("hi", { messages: [{ role: "assistant", content: "hi" }] })] },
});
// the reply invoke resolves with { result: 'hi', messages: [...] }
```

Pick boundary values for numeric payloads: each guard threshold on both sides. Values between two boundaries take the same branch as one of them.

`report.vacuous` lists event types offered only as the bare `{ type }` at a snapshot where a transition for them may read the payload: no `payloads` entry, no decision option, and no schema variant beyond `{ type }`.

- Covers a type with no schema, or a schema the fill cannot enumerate (a required free-form field, a product over 64, an object of only optional free-form fields).
- Not listed: a partial fill with real variants, such as finite fields plus an optional free-form one. That type is only in `unexpandedEvents`.
- Also lists `@agent.usage` when a text request settled while a usage transition was active and `usage` had no entry for its src. See [Usage events](#usage-events).
- Otherwise a subset of `unexpandedEvents`. Data only: completeness is unchanged.

### Interleaved events

By default, external events fork only at idle waits. A host event that arrives while an invoke is still running is never explored. `interleave: "pending"` explores it.

| `interleave`       | External events fork at                                                                                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"idle"` (default) | Idle waits.                                                                                                                                                                 |
| `"pending"`        | Idle waits, plus every point an invoke is outstanding: before a text or scripted invoke resolves, at an output or error fork, at a `needs-output` block, and at a decision. |

- Each event the active states (or ancestors) accept forks once per payload variant, the same variants as an idle wait. A decision races only the events it does not offer as candidates.
- Each race branch spends one level of `maxDepth`. Resolving a single canned output does not.
- `payloads`, `dedupeBy`, and guard pruning apply as at idle waits.
- A state that accepts no external event resolves straight through, as before.

```ts no-check
const report = await explorePaths(lookupMachine, {
  outputs: { lookup: [{ found: true }] },
  interleave: "pending",
});
// report.terminals → 'found' (no race), and 'cancelled' via [{ type: 'CANCEL' }]
```

### Timers

An armed timer is an event that may arrive. The search reads `snapshot.timers`: `after` delays, state and invoke `timeout`s, and delayed `enq.raise` events.

- Each armed timer whose event the active states take forks a branch, where host events fork: at idle waits, and while work is pending under `interleave: "pending"`.
- Timers fire in any order, regardless of their delays. A witness may fire a long timer before a short one.
- A fired timer records its event in the path, such as `{ type: 'xstate.after', delay: 1000, stateId: 'm.waiting' }`, and is disarmed, as in a run.
- An explored or coupled child's timers fire in the child's own search.
- `timers: "ignore"` never fires a timer. A wait with an armed timer adds a `timers:` note to `unexplored` and lists the timer's event type in `unexpandedEvents`, so the report is not complete.

```ts no-check
const result = await canReach(waitingMachine, "timedOut");
// result.witness → [{ type: 'xstate.after', delay: 1000, stateId: 'm.waiting' }]
```

### Usage events

`usage` lists usage values per text-request src, so a budget guard on `@agent.usage` can be proved.

- When a root text request with an entry settles and the active states take `@agent.usage`, the search delivers the usage event to the root immediately before the request's completion, as a run does.
- The event is `{ type: '@agent.usage', kind: 'text', id, src, model, name?, usage }`, the run's shape without `budget`.
- Each listed value forks one branch, recorded in the path before `xstate.done.actor`.
- One value with one canned output is no fork: the output resolves straight through, but the usage event is still recorded in the path.
- A usage value the active states refuse (`snapshot.can` is false) is dropped, as a run drops it: the request settles with no usage event delivered or recorded.
- A usage transition that leaves the invoking state, or restarts its invoke, cancels the request: its completion is not recorded, and a restarted invoke settles later on its own.
- A settling request with no `usage` entry while a usage transition is active lists `@agent.usage` in `vacuous`. Completeness is unchanged.
- With `children: "coupled"`, a child's text request with an entry forks one branch per value. The usage event goes to the root before the child's completion reaches its parent. The root takes it or drops it by the same rules. A child's request with no entry is not listed in `vacuous`.
- Requests inside `"outputs"` or `"explore"` children, and decisions, deliver no usage.

```ts no-check
const overBudget = await canReach(researchMachine, "outOfBudget", {
  outputs: { summarize: ["notes"] },
  usage: { summarize: [{ totalTokens: 10 }, { totalTokens: 5000 }] },
});
// overBudget.witness → [{ type: '@agent.usage', ..., usage: { totalTokens: 5000 } }]
```

### Child machines

By default, a child machine is a src like any other: with no `outputs` entry, its branch ends `needs-output`. `children: "explore"` explores the child instead. It covers invoked children and children spawned with `enq.spawn(actors.x, { id, input })`.

- Applies when the src has no `outputs` or `errors` entry and its logic is a state machine.
- The child is explored on its own, from its invoke or spawn input, with the same options and caps, to at most 4 nested levels.
- Events reach the child only as `childEvents` lists them: `{ [src]: eventTypes }`, the types the parent forwards (`sendTo`/`forwardTo`) or the host sends the child. Default none. A child wait that accepts an unlisted type makes the child search incomplete, never a reachable parent path.
- Each distinct `output` of the child's `done` terminals forks the parent as an output. One output resolves straight through.
- Each distinct failure of the child's `error` terminals forks a failing branch, recorded with `error`.
- Each distinct event the child sends its parent (`sendTo(parent, …)`) on any explored path forks the parent receiving it, recorded as the event itself.
- A child that can end `idle` adds an `idle` terminal to the parent: the parent can wait there forever.
- Bounded:
  - Child idle waits are not parent fork points. The child is explored to its finals, and its distinct outputs fork the parent.
  - N children are explored independently, not as a product of their states. While an explored child is pending, it and every other pending invoke or text request settle in any order; one with no `outputs` entry adds a `needs-output` terminal, and a pending decision's choices branch from the same point. Other combinations are not enumerated beyond `interleave`.
  - A child's events and outputs are not correlated: each event reaches the parent at most once per path, in any order, before or without the others, and before any of the child's outputs. This over-approximates the child, so a witness may not be a live path. A child that sends the same event twice is covered once. For witnesses that are live runs, use `children: "coupled"`.
- An incomplete child search, such as one with its own `needs-output` or `max-depth`, also ends the parent branch `needs-output` for that src, so the parent report is not complete. The child's `unexpandedEvents` and `vacuous` join the parent's.

```ts no-check
const report = await explorePaths(parentMachine, {
  children: "explore",
  childEvents: { approval: ["YES", "NO"] }, // the parent forwards both
});
// report.terminals → one branch per distinct child output, e.g.
// [{ type: 'xstate.done.actor', actorId: 'approval', output: { ok: true } }]
```

### Coupled child machines

`children: "coupled"` steps each child machine inside the parent's search, one move at a time. A witness is then a run the parent and its children can make together. Use it for child machines you wrote, such as one machine per tool call in a batch.

- The same children qualify as for `"explore"`: invoked or spawned state machines with no `outputs` or `errors` entry.
- A child's events reach the parent in the order the child sends them on its own path. Its output follows them.
- An event the parent sends a child with `sendTo`/`forwardTo` is applied to that child's state at once, in order. It does not need a `childEvents` entry.
- `childEvents` lists only the types the host sends the child directly. Default none.
- A child's pending work races the events that can reach it, as with `interleave: "pending"`.
- The parent's host events arrive at its idle waits, including while every child waits on the host. While a child or the parent has work pending, they race it only with `interleave: "pending"`.
- What a child's move sends its own children, and their replies, happen in the same move. A child's send to a sibling is delivered to that sibling, entry sends included. A child's sends reach their targets in the order it made them, each run to quiescence before the next, as a live run does. A send to an actor the search does not model lists the event type in `unexpandedEvents`, so the report is not complete.
- Child moves count against `maxDepth` like the parent's own branches. On a path they carry `actor` with the child's id (a grandchild's as `child.grandchild`): the host events it received, its choices, its settled work. The events it sends the parent appear as the parent receives them.
- A target predicate and `dedupeBy` see each coupled child's explored state: `snapshot.children[id].getSnapshot()` returns the state the search stepped the child to, its own coupled children likewise. A parent's send and the child's receipt are one state, so a cross-actor invariant such as "every chunk the parent forwarded, a child received" can be a target.
- With `dedupeBy`, each child's state joins the key. Without it, every interleaving is explored in full.
- A coupled child's text requests deliver `@agent.usage` to the root, as a run does. See [Usage events](#usage-events).
- A child that stops on `needs-output` or `max-depth` ends the parent branch the same way, so the parent report is not complete.

Pass `hostEvents` when some types the parent accepts come only from its children, such as a child's status events. The search then offers only the listed types at the parent's waits.

```ts no-check
const result = await canReach(batchMachine, executedWhileAwaiting, {
  input: { calls: [read, write] },
  children: "coupled",
  childEvents: { call: [] }, // every event a call receives comes through the batch
  hostEvents: ["APPROVE", "REJECT", "CANCEL_ALL"], // CALL_READY comes only from calls
  outputs: { policy: ["allow", "ask"], execute: ["ok"] },
  dedupeBy: (snapshot) => JSON.stringify([snapshot.value, snapshot.context]),
});
// → { reachable: false, complete: true }: no call runs while another awaits a person
```

`"explore"` stays the over-approximation: it sends a child's events in any order and does not correlate them with its outputs. A witness there may not be a live run. Prefer it only when you do not want the proof to depend on the child's own logic.

### Budgets

`maxPaths` and `maxNodes` apply to each search on its own. With `children: "explore"`, every explored child is a search of its own with the same caps, so a parent with two loopy children can expand far more than `maxNodes`. `budget` bounds the whole call.

- `budget.nodes`: branch points expanded in total, by the top-level search and every child search it triggers. A cached child outcome counts once, when it is computed. Default 250,000, so a search with loopy children stops instead of growing without bound. Raise it explicitly for a bigger machine.
- `budget.ms`: wall-clock milliseconds from the start of the call. It is checked at each branch point, in child searches too. A slow `payloads` or guard call is not interrupted. No default.
- `budget.childCache`: explored-child outcomes kept for reuse, keyed by logic, src, and input. The least recently used one is evicted first. An evicted child is explored again when reached, and counts against `budget.nodes` again. Default 64.

When a budget runs out, the search stops and returns what it has:

- `report.partial` is true and `report.complete` is false.
- `report.unexplored` has one note, `budget-exhausted: nodes` or `budget-exhausted: ms`, with the nodes expanded and the milliseconds spent so far.
- `canReach` returns `reachable: true` with its witness if it found one first. Otherwise it returns `{ reachable: false, complete: false }` with the budget note in `unexplored`, which proves nothing: the target may be reachable on a branch the search did not reach.

```ts no-check
const report = await explorePaths(parentMachine, {
  children: "explore",
  budget: { nodes: 50_000, ms: 10_000 },
});
// report.partial → true when the budget ran out
// report.unexplored → [..., 'budget-exhausted: nodes (50000 nodes expanded in 812 ms, child searches included)']
```

Set `budget.ms` under the test runner's timeout, so a long search fails its assertion instead of the worker.

## Reachability checks

<!-- canReach contract from src/verify.ts -->

`canReach(machine, target, opts)` wraps `explorePaths` to answer whether a target is reachable, with a witness path when it is. The target (`CanReachTarget`) is one of:

- A state path or state-node ID.
- A snapshot predicate, `(snapshot) => boolean`, for a property no single state names: a context invariant, a tag, a state plus context.

```ts no-check
const violation = await canReach(
  refundMachine,
  (snapshot) => snapshot.matches("issued") && !snapshot.context.approved,
  { input: { amount: 5000 } },
);
// violation.reachable → false with complete: true is the safety proof
```

A state the machine only passes through within one step counts as reached: one left at once by an `always` transition, or a `choice` state. `canReach` returns the path that transits it, and `explorePaths` lists it in `reachedStates`.

`reachable: false` proves unreachability only when `complete` is true. `complete` is false when the search left a branch it could not rule out:

- `maxPaths`, `maxNodes`, or the `budget` cut the search short.
- A path reached `maxDepth`.
- A branch stopped on a `needs-output` terminal, with no `outputs` entry for its src, or an explored child machine whose own search was incomplete.
- An event type was not expanded to all its payload variants, as `explorePaths` lists in `unexpandedEvents`.

When `complete` is false, `unexplored` lists why, in the wording of the `explorePaths` report's `unexplored` notes, such as `needs-output: no \`outputs\` entry for src 'resume' at path []`. A cap adds a `path-cap` note.

Raise the caps, add `dedupeBy`, supply the missing outputs, or add `payloads` entries until it is true.

A long-lived machine that never finishes, such as a chat loop, ends every path at `maxDepth`, so `complete` is never true. Its proofs are bounded:

- `reachable: false` whose only `unexplored` notes are `max-depth` notes means no path of up to `maxDepth` branch points reaches the target.
- Any other note, such as `needs-output` or `unexpanded`, is a gap within that bound too.
- Raise `maxDepth` to extend the bound. `dedupeBy` keeps a deep bound tractable.

```ts
import { canReach } from "@statelyai/agent/testing";
const { reachable, witness } = await canReach(refundMachine, "denied", {
  input: { request: "x", amount: 5000 },
});
// reachable → true; witness → [{ type: 'NEEDS_REVIEW' }, { type: 'DENY' }]
```

`witness` is the sequence of chosen and applied events that reaches the state, which is the proof that it is reachable. It is absent when `reachable` is `false`.

- The witness is a shortest one: no path within `maxDepth` reaches the target in fewer events. A recorded `xstate.error.actor` or `xstate.done.actor` entry counts as one event.
- `canReach` searches breadth first to find it, so a retry loop never pads the witness. `explorePaths` stays depth first, and its terminal order is unchanged.

`canReach` forwards `errors`, so a state that only a failure reaches is checkable the same way.

```ts
const failure = await canReach(machine, "failed", {
  errors: { parse: new Error("truncated response") },
});
// failure.reachable → true; failure.witness → [{ type: 'xstate.error.actor', actorId: 'parse' }]
```

## CI checks

Everything on this page runs without an API key, so a small script is enough for CI or a generation loop.

```ts no-check
// check.ts (run with: npx tsx check.ts)
import { assertAgentMachine } from "@statelyai/agent/testing";
import { machine } from "./machine";

assertAgentMachine(machine); // throws AgentLintError on error-severity findings
```

For machines authored as data, validate the config with `validateAgentConfig(config)` from `@statelyai/agent/validate` first, then compile it and lint the machine: `assertAgentMachine(setupAgent.fromConfig(config, { compileSchema }).machine)`. See [Machines as data](machines-as-data.md). Every check applies, including reachability. The lowering keeps the config's transition targets, so `unreachable-state` reads the real graph even where the JSON layer folds a target into a resolver function. `verifyAgentConfig` runs validation, lowering, lint, and exploration in one call. See [Generating machines with an LLM](generate-machines.md).

## Related

- [Crash testing](persistence.md#crash-testing): `checkCrashRecovery` kills a run at every log append and in-flight effect, and checks each resume.
- [Debugging](debugging.md): scripted reproduction and the diagnostic codes in context.
- [Evals](evals.md): scoring runs on output, trajectory, and budget.
- [Quickstart](quickstart.md#define-and-run-one-artifact): a plain-function executor for `runToQuiescence`.
- [Machines as data](machines-as-data.md): verifying a machine lowered from a config.
- [Migrating from a hand-rolled loop](from-a-loop.md): pinning behavior across a refactor.
- [examples/verification](https://github.com/statelyai/agent/blob/next/examples/verification/index.ts): every API on this page run over one refund-approval machine, with no API key, including `canReach` proving that an over-limit payout without human approval is unreachable.
