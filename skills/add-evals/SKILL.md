---
name: add-evals
description: Write evals for a @statelyai/agent or XState agent machine at the right level — rule checks with no model, decision evals at one decision state, outcome evals over whole runs, and per-state stats from traces — each tied to the states it covers. Use when asked to "write evals", "add evals for the approval logic", "test the agent", "measure the agent", "build an eval suite", or "what should I eval" for an agent built as a state machine.
---

# Add evals to an agent machine

The machine tells you what to eval and at which level. Every eval names the states it covers, so a failing eval points at a part of the machine.

```
read the machine → map the request to states → pick the level per state → write the evals → baseline → hand back
```

This is step 3 of 4. Before: `loop-to-machine`, `add-traces`. Next: `improve-machine`.

## Hard rules

- **The cheapest level that can catch the failure.** A rule is checked without a model. Only judgment needs a model in the eval.
- **Ground truth, never a model's opinion of itself.** Outcome evals read terminal states and effects in the world. A model grades text only where no ground truth exists, and that eval says so in its name.
- **Labels belong to people.** Draft expected outcomes and expected events; ask the user to confirm them before they gate anything. Keep drafts in their own list, marked unconfirmed, and out of every gate.
- **Never edit the machine to make an eval pass.** A failing eval is a finding. Report it.
- **Held-out scenarios stay held out.** Evals may run on them; nobody tunes against them.

## 1. Read the machine

```ts
import { describeMachine } from "@statelyai/agent";
console.log(describeMachine(machine)); // goal, states, transitions, events
```

List:

- the decision states: an `agent.decide` invoke, a `decision` tag, or a state a host answers with `decideNext`;
- the person's steps: idle states a person answers (`meta.interaction`, the runner's `onIdle`). What the person decides is ground truth, not something to eval; the routing after their answer is a rule;
- the guards. `describeMachine` shows where a transition function can go and marks it `(conditional)`, but not the guard's name or logic. Read the source for those;
- the sentinel states and the final states.

## 2. Map the request to states

Turn the user's words into states. "Evals for the approval logic" means every state and guard that touches approval: the guard that routes a refund over the threshold, the approval step and each answer to it, the sentinel check before the payment, and the final states they lead to. Write the mapping down:

| Asked about | States and guards                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------- |
| approval    | `deciding` (REFUND: over threshold → `awaitingApproval`), `awaitingApproval` (APPROVE, REJECT), `paying` (sentinel check), `issued`, `closed` |

If the request names nothing ("write evals"), cover every decision state, every sentinel, and the run as a whole.

## 3. Pick the level

| Level        | Catches                                              | Runs a model          | Tools                                                              |
| ------------ | ---------------------------------------------------- | --------------------- | ------------------------------------------------------------------ |
| **Rule**     | A guard, an ordering, an invariant that must hold    | No                    | Exported guard functions, `canReach`, `explorePaths`, `simulateAgent` |
| **Decision** | A wrong choice at one decision state                 | The decider under test | The decider called on recorded or written decision requests        |
| **Request**  | A bad text output from one request                   | That request          | `runSeam`, scored on `seamOutput` and the path after it. Not applicable when the machine has no text requests; say so |
| **Outcome**  | A wrong end result for a whole scenario              | The whole agent       | Scenarios, the runner, an objective over terminal states and effects |
| **Stats**    | Which state the failures cluster in                  | No (reads traces)     | `foldTraces`                                                       |

A guard or ordering is always a rule eval. Use a decision eval when the guards leave more than one legal option. Use an outcome eval when a person can label the right end result.

## 4. Write them

Name every eval `<state>: <what it checks>`, so the report reads as a map of the machine. An outcome eval over a whole run takes the final state it expects (`issued: partial-refund refunds 50 dollars`). In `test.each` titles, `$name` is a placeholder: write amounts as `100 dollars`, not `$100`.

**Rule evals**, from `@statelyai/agent/testing`:

```ts
test("paying: no refund over 100 dollars issues without approval", async () => {
  const result = await canReach(machine, "<sentinel>", { input, payloads, outputs, errors });
  expect(result.complete).toBe(true); // reachable: false is a proof only when the search finished
  expect(result.reachable, JSON.stringify(result.witness)).toBe(false);
});

test("deciding: REFUND over the order amount never reaches paying", async () => {
  const result = await canReach(machine, (s) => s.matches("paying") && s.context.amount > s.context.order.amount, { input, payloads, outputs });
  expect(result.complete).toBe(true);
  expect(result.reachable).toBe(false);
});
```

Check guards through the machine, not by importing the guard and calling it: an imported `refundIsLegal` is always the one in the source, so it passes on a machine built with a loosened guard. A unit test of the guard function is fine as well, never instead.

Use `explorePaths` to assert the set of reachable final states, and `await simulateAgent(...)` for one scripted path. Cover both sides of every threshold. The two treat a closed choice differently:

- `explorePaths` and `canReach` use `options.payloads` **instead of** the decision's own offered options, so they explore values the machine would never offer. That is what a boundary proof needs.
- `simulateAgent` keeps the offered options: a scripted event the decision did not offer is refused, and the run ends in the decision's `onError`. Script only offered events, or pick an input that offers the value.

**Decision evals.** A row is a decision request and the event a person says is right. Write rows by hand, or take them from recorded traces with `getDecisionRequests(trace, { name })` from `@statelyai/agent/testing`: each decision's first attempt, with the states it was asked in, its `options`, and its `metadata`. Compare events without caring about key order. If the decider reads anything outside the request (the ticket, the tool history), store that in the row too.

```ts
import { getDecisionRequests } from "@statelyai/agent/testing";

// One row per recorded decision; `expected` is the label a person confirmed for that decision.
// A scenario can decide more than once, so label each decision by its position, not the scenario alone.
const rows = traces.flatMap(({ scenario, trace }) =>
  getDecisionRequests(trace, { name: "chooseResolution" }).map(({ request }, i) => ({
    id: `${scenario.id}#${i}`,
    request,
    expected: labels[`${scenario.id}#${i}`],
  })),
);

test.each(rows)("deciding: $id", async ({ request, expected }) => {
  const { event } = await decide(request); // the policy decider, or the model executor
  expect(event).toEqual(expected);
});
```

Which deciders gate CI: a deterministic reference decider (a scripted or rules-based one) gates. A live model is a measurement, not a unit test: run it outside CI, several times, and report the rate. A seeded random decider is measured over several seeds, never gated.

**Request evals.** For a text request (a drafted question, a summary), `runSeam(machine, { input, scripts, seam: { request: "draftQuestion" }, candidate })` runs the whole machine with only that request live. Score `seamOutput`, and the states the run reached after it.

**Outcome evals.** One function over a batch of scenario runs, reading ground truth. Score the effects as well as the outcome: a run that ends `issued` with the wrong amount is wrong.

```ts
export function objective(runs: Array<{ scenario: Scenario; outcome: string; refund?: Refund; violations: number; modelCalls: number }>) {
  return {
    accuracy: runs.filter((r) => r.outcome === r.scenario.expected && sameRefund(r.refund, r.scenario.expectedRefund)).length / runs.length,
    violations: runs.reduce((n, r) => n + r.violations, 0), // must be 0
    modelCalls: runs.reduce((n, r) => n + r.modelCalls, 0), // cost
  };
}
```

Read the terminal state from the event logs `add-traces` recorded (`replay(machine, entries).snapshot`, `replay` from `@statelyai/agent/log`). Effects and violations live in the world, not the log: save them next to the thread id when the run ends, so the objective can be recomputed without running anything. Use `matchesTrajectory` only for an ordering a person requires (approval before payment), never to pin the whole path; build its input from the `machine.transition` trace events' `snapshot.value`.

**Stats.** `foldTraces(traces, { failed })` (from `@statelyai/agent/testing`) returns `{ state, visits, failures, withheld }` per state. A failed run counts against **every** state it visited, so states after a bad decision rank as high as the decision itself. Use the table to see which states failing runs pass through, then look at the decision states among them, their `withheld` counts, and their decision attempts. `failed` sees only the trace: to judge a run against its label, keep a map from trace to scenario.

## 5. Coverage

If every decider scores the same on the confirmed scenarios, the scenarios cannot tell a better decider from a worse one. Draft scenarios on the boundaries the evals found (an amount just under and over a threshold, a partial request), label them as drafts, and ask the user to confirm them and add them to the scenario set. They become part of the train or held-out split only once confirmed.

## 6. Baseline

Run every eval once on the current machine and record the numbers: which pass, the outcome scores per split, the stats table. Failing evals are findings, not bugs in the eval, unless the label was wrong; then ask.

## 7. Hand back

1. The state mapping from step 2.
2. The evals by level, each named by state.
3. The baseline numbers, train and held-out separately.
4. Every failing eval and the state it points at.
5. Next step: `improve-machine`, with the objective from step 4 as its scorer.
