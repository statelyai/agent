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
- **Labels belong to people.** Draft expected outcomes and expected events; ask the user to confirm them before they gate anything.
- **Never edit the machine to make an eval pass.** A failing eval is a finding. Report it.
- **Held-out scenarios stay held out.** Evals may run on them; nobody tunes against them.

## 1. Read the machine

```ts
import { describeMachine } from "@statelyai/agent";
console.log(describeMachine(machine)); // goal, states, transitions, events
```

List the decision states (an `agent.decide` invoke, a `decision` tag, or a state a host answers with `decideNext`), the guards, the sentinel states, and the final states.

## 2. Map the request to states

Turn the user's words into states. "Evals for the approval logic" means every state and guard that touches approval: the guard that routes a refund over the threshold, `requestingApproval`, its done and error transitions, and the final states it leads to. Write the mapping down:

| Asked about | States and guards                                          |
| ----------- | ---------------------------------------------------------- |
| approval    | `deciding` (REFUND guard: over threshold), `requestingApproval`, `closed` |

If the request names nothing ("write evals"), cover every decision state, every sentinel, and the run as a whole.

## 3. Pick the level

| Level        | Catches                                              | Runs a model          | Tools                                                              |
| ------------ | ---------------------------------------------------- | --------------------- | ------------------------------------------------------------------ |
| **Rule**     | A guard, an ordering, an invariant that must hold    | No                    | Exported guard functions, `canReach`, `explorePaths`, `simulateAgent` |
| **Decision** | A wrong choice at one decision state                 | The decider under test | The decider called on recorded or written decision requests        |
| **Request**  | A bad text output from one request                   | That request          | `runSeam`, scored on `seamOutput` and the path after it            |
| **Outcome**  | A wrong end result for a whole scenario              | The whole agent       | Scenarios, the runner, an objective over terminal states and effects |
| **Stats**    | Which state the failures cluster in                  | No (reads traces)     | `foldTraces`                                                       |

A guard or ordering is always a rule eval. Use a decision eval when the guards leave more than one legal option. Use an outcome eval when a person can label the right end result.

## 4. Write them

Name every eval `<state>: <what it checks>`, so the report reads as a map of the machine.

**Rule evals**, from `@statelyai/agent/testing`:

```ts
test("requestingApproval: no refund over $100 issues without approval", async () => {
  const { reachable, witness } = await canReach(machine, "illegallyIssued", { /* payload variants, invoke outputs */ });
  expect(reachable, JSON.stringify(witness)).toBe(false);
});

test("deciding: REFUND over the order amount is refused", () => {
  expect(refundIsLegal({ ...context, order: { ...order, amount: 40 } }, 41)).toBe(false);
});
```

Use `explorePaths` to assert the set of reachable final states, and `simulateAgent` for one scripted path (`docs/verify.md`). Cover both sides of every threshold.

**Decision evals.** A row is a decision request and the event a person says is right. Get rows from recorded traces (the `request.start` trace events of decisions, which carry `options`), or write them by hand. Run the decider under test on each:

```ts
const rows: Array<{ id: string; request: AgentExecutorDecisionRequest; expected: ChosenEvent }> = loadDecisionRows("deciding");

test.each(rows)("deciding: $id", async ({ request, expected }) => {
  const { event } = await decide(request); // the policy decider, or the model executor
  expect(event).toEqual(expected);
});
```

A decision eval against a live model is a measurement, not a unit test: run it outside CI, several times, and report the rate.

**Request evals.** For a text request (a drafted question, a summary), `runSeam(machine, { input, scripts, seam: { request: "draftQuestion" }, candidate })` runs the whole machine with only that request live. Score `seamOutput`, and the states the run reached after it.

**Outcome evals.** One function over a batch of scenario runs, reading ground truth:

```ts
export function objective(runs: Array<{ scenario: Scenario; outcome: string; violations: number; modelCalls: number }>) {
  return {
    accuracy: runs.filter((r) => r.outcome === r.scenario.expected).length / runs.length,
    violations: runs.reduce((n, r) => n + r.violations, 0), // must be 0
    modelCalls: runs.reduce((n, r) => n + r.modelCalls, 0), // cost
  };
}
```

Read outcomes from the event logs `add-traces` recorded (`replay(machine, entries).snapshot`), so an outcome eval can be recomputed without running anything. Use `matchesTrajectory` only for an ordering a person requires, never to pin the whole path.

**Stats.** `foldTraces(traces, { failed })` returns `{ state, visits, failures, withheld }` per state. Sort by `failures / visits` to find where failures cluster. This is the diagnosis input for `improve-machine`.

## 5. Baseline

Run every eval once on the current machine and record the numbers: which pass, the outcome scores per split, the stats table. Failing evals are findings, not bugs in the eval, unless the label was wrong; then ask.

## 6. Hand back

1. The state mapping from step 2.
2. The evals by level, each named by state.
3. The baseline numbers, train and held-out separately.
4. Every failing eval and the state it points at.
5. Next step: `improve-machine`, with the objective from step 4 as its scorer.
