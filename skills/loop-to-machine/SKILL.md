---
name: loop-to-machine
description: Convert existing agent code (a while-loop around a model, a tool loop, ad-hoc if/else control flow) into an XState v6 state machine with @statelyai/agent, and prove with a parity report that it behaves like the code it replaces. Use when asked to "turn this agent into a state machine", "port my loop to xstate", "make this a statechart", "refactor this agent into a machine", or "split environment and policy" for code that already runs.
---

# Convert agent code to a machine

You replace the control flow of working agent code with a machine, and show where the machine behaves like the old code and where it differs on purpose. The model calls, tools, and retry code move across unchanged.

```
inventory → pin the baseline → environment → (policy) → runner → proofs → parity → hand back
```

This is step 1 of 4. Next: `add-traces`, then `add-evals`, then `improve-machine`. To author a machine with no existing code, use `generate-machine`.

## Hard rules

- **Pin the baseline before you change anything.** The parity test runs against the old code, which stays in the repo, untouched, until a person deletes it.
- **Never promise "behaves exactly like".** Promise what the parity report shows: same outcome and effects on these scenarios, with every difference labeled.
- **Never copy a rule break.** Where the old code broke a rule, the machine blocks it. That difference is `intended`, not a regression.
- **Rules are code, not prompt text.** A rule that lived only in a system prompt becomes a guard. Keep the prompt line only as context for the model.
- **Business rules belong to people.** If a rule is ambiguous (which threshold, which order of checks), ask. Never pick one silently.

## 1. Inventory the code

Read the loop and fill this table before writing anything. Each row maps to a machine element.

| In the code                                                                  | Becomes                                                                  |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| A tool with a side effect someone must gate (refund, send)                   | An actor invoked by one state, entered only through a guarded transition |
| A read-only tool (search, lookup)                                            | An actor the machine invokes itself, or a tool on a text request         |
| A rule: an `if`, a prompt line, a check after the fact                       | A guard on the transition it protects                                    |
| A point where the model picks what to do                                     | A decision state: `agent.decide`, usually a closed choice                |
| A value the model pulled out of the input (an order id, an amount)           | Code when the format is fixed (a regex); a text request when it is not   |
| A step every correct run takes in the same order (verify, then look up)      | A state the machine enters itself; the model no longer chooses it        |
| A person in the loop: `await approve()`, a returned `pending`, or a tool that asks a person (`askCustomer`, `requestApproval`), even a synchronous one | An idle state with `meta.interaction`, answered by `onIdle` in the runner |
| A cap (`turns < 8`, a retry counter) on a loop the machine keeps             | A `choice` state against an exported constant                            |
| A cap on a loop the machine removed                                          | Nothing. Record that it is gone and why                                  |
| Each distinct return                                                         | A final state                                                            |
| A terminal tool with a side effect (`escalate`, `close`)                     | A state that invokes it, then the final state; its `onError` goes to a `failed` final |

List the rules as a numbered list in your notes. Every one must end as a guard, a state ordering, or a written reason it was dropped.

## 2. Pin the baseline

The parity test exists before the machine does.

1. **Scenarios.** Reuse the code's tests, fixtures, or benchmark cases. Each has an `id` and, where people know it, the `expected` outcome. If there are none, draft 6–10 that cover every terminal and every rule, and ask the user to confirm them.
2. **Deterministic stand-in models.** Parity with a live model drifts between runs. Use the code's scripted or mock models if it has them; otherwise write one keyed on the input (see [`examples/mock-model.ts`](https://github.com/statelyai/agent/blob/main/examples/mock-model.ts) in the `statelyai/agent` repo). You want two: one that follows the rules, and one that breaks them. A seeded random model needs its seed derived from the scenario id and a fresh instance per run, or every scenario replays the same draws.
3. **Ground truth.** Read outcomes and effects from the world, not from the agent's own report. `effects` holds **every write the world records**: the refunds, and also the approvals, the verifications, the questions asked, the escalations. A refund issued without its approval looks correct if `effects` holds only refunds. Text a model wrote (an escalation reason) differs on every run: compare its count or presence, not the text. If the world can check rules after the fact, return those violations. If it cannot, write the check as a plain function over the effects.
4. **The harness check.** Run the old code on both sides with each stand-in model. Each row's baseline must equal its candidate (the runs are deterministic), and with the rule-following model every row must be `same`. With a rule-breaking model, rows are `regression` by design: the candidate breaks rules.

```ts
import { compareRuns, type ParityResult, type ParityRun } from "@statelyai/agent/testing";

function toParityRun(run: { outcome: string; world: World }): ParityRun {
  return {
    outcome: run.outcome,
    // Every write the world records; model-written text as a count.
    effects: { refunds: run.world.refunds, approvals: run.world.approvals, verified: [...run.world.verified], escalations: run.world.escalations.length },
    violations: run.world.violations, // rules broken, from ground truth
  };
}

// A model factory, called once per scenario and per side. Construct a stateful or seeded
// model inside it (seeded from s.id); returning a shared stateless object is fine.
const runWith = (runner: typeof runLoop, model: (s: Scenario) => Model) => async (s: Scenario) =>
  toParityRun(await runner({ ...s, model: model(s), world: createWorld(s) }));

const MODELS: Array<[string, (s: Scenario) => Model]> = [
  ["careful", () => carefulModel],
  ["sloppy", () => sloppyModel],
];

test.each(MODELS)("harness: the loop matches itself (%s)", async (_, model) => {
  const report = await compareRuns({ scenarios: SCENARIOS, baseline: runWith(runLoop, model), candidate: runWith(runLoop, model) });
  for (const row of report.scenarios) expect(row.candidate, row.id).toEqual(row.baseline);
});
```

## 3. Author the environment

The environment is the machine: states, guards that encode the rules, side-effecting actors, an invariant sentinel. Use `setupAgent` (from `@statelyai/agent`) with zod schemas for `input`, `context`, `output`, and every event. Export the event schemas as one object, so a policy can reuse them later.

A gated action:

```ts
deciding: {
  tags: ["decision"],
  invoke: {
    src: "agent.decide",
    input: ({ context }) => ({
      model: "decider", // a key the host's executors resolve
      name: "chooseResolution", // tests, traces, and a later policy find it by this name
      prompt: `Ticket: ${context.ticket}\nOrder: ${JSON.stringify(context.order)}`,
      allowedEvents: ["REFUND", "ESCALATE", "CLOSE"],
      // A closed choice: the decider picks one of these. The runtime drops the ones the guards refuse.
      payloads: { REFUND: refundAmounts(context).map((amount) => ({ amount })) },
      // The facts a decider reads. Arrives as `request.metadata.facts`.
      metadata: { facts: { order: context.order, requestedAmount: context.requestedAmount } },
    }),
    onError: { target: "escalated" }, // retries exhausted, or no option legal
  },
  on: {
    REFUND: ({ context, event }) =>
      refundIsLegal(context, event.amount)
        ? { target: event.amount > APPROVAL_THRESHOLD ? "awaitingApproval" : "paying", context: { amount: event.amount } }
        : undefined, // undefined rejects: the decision retries with feedback
    ESCALATE: { target: "escalated" },
    CLOSE: { target: "closed" },
  },
},
```

- **Do the deterministic steps yourself.** Identity, lookup, the ownership check: states the machine runs in order. A model only answers what genuinely needs judgment.
- **Export the guards** as plain functions (`refundIsLegal`) so tests can call them, and build the machine in a factory (`createDeskMachine({ refundIsLegal })`) so a test can pass a loosened guard.
- **Add an invariant sentinel** for the rule that must never break: a final state with a description starting `SENTINEL:`, entered from an `always` on the state that invokes the side effect (`paying`). An `always` is taken before the state's invoke starts, so the effect never runs. Write the check as its own function, not a call to the guard, so loosening the guard does not loosen the check.
- **A person's step** is an idle state whose `meta.interaction` tells a host what to render: `{ label: "Approve a refund of ${amount}?", events: { APPROVE: { label: "Approve" }, REJECT: { label: "Reject" } } }`, or `textEvent: { type: "CUSTOMER_REPLIED", field: "reply" }` for free text.
- **Actors are placeholders.** Declare each tool as `createAsyncLogic<Output, Input>({ run })` from `xstate` in `setupAgent({ actors })` (XState v6 has no `fromPromise`). Give the type parameters, or `onDone`'s `output` is untyped. Pass the real implementations at run time with `runAgent(machine, { actors })`.
- **Final outputs carry the machine's result** (`{ outcome, orderId, amount }`), JSON only. The runner rebuilds the old return type from it and from the world (step 5).
- **Declare `version`** on `createMachine` (`version: "1"`). Behavior lives in transition functions, which the structural hash cannot see; traces stamp this string.

## 4. A policy, only if the code already has one

Keep the decision in the environment as one `agent.decide`, and do not write a policy machine, unless the old code already has decision logic beyond one model call: a rule ladder, heuristics that pick a strategy, a cheap check before the model. A policy that only passes the options through to a model is boilerplate. `improve-machine` introduces a policy when the traces show a rule worth adding.

If the code does have that logic, port it as a policy machine that answers `chooseResolution`. The pattern, with code that compiles, is in [policy.md](policy.md).

## 5. The runner

Write `runMachine` with the old function's signature and result type, so callers and the parity test change one line.

- `runAgent(machine, { input, executors, actors, onIdle })`.
- `onIdle` answers each idle state with the old code's call (`tools.askCustomer(...)`, `tools.requestApproval(...)`). Write the returned events with `as const` on `type`, or the event union does not narrow.
- `executors.decide` adapts the code's model to the decision: the closed choice arrives as `request.options` (each `{ event }`), and the facts as `request.metadata?.facts`, typed `unknown`: parse it with the exported facts schema. Every executor slot is optional in the type; check or assert the ones you call.
- Rebuild the old result from `result.output` and the world. A field that has no meaning anymore (a turn count with no loop) keeps its type and gets a comment saying what it now holds.

## 6. Proofs that need no model

From `@statelyai/agent/testing`:

- `lintAgentMachine(machine)`: no errors.
- `canReach(machine, "<sentinel>", options)` returns `reachable: false` **and** `complete: true`, for each distinct input shape (an input with an order id and one without lead to different paths; loop over them).
- `options.payloads` lists values on both sides of every guard boundary (`0, 40, 41, 100, 101, 240, 241, 1000`). Without it, a closed choice is explored only with its own `payloads`, and `complete: true` then proves nothing about the boundaries.
- `options.outputs` lists every output each actor can return (found and not found, owned and not, refunded and not); `options.errors` makes each actor fail once.
- A loosened guard makes `canReach` true. Write this test too, or the proof proves nothing.
- Each normal final state is reachable, so the search is not vacuous.

Type the options with `ExplorePathsOptions` from `@statelyai/agent/testing`. `errors` takes one error per actor src, and `"agent.decide"` is a valid key.

## 7. Parity

Switch the parity test's candidate to `runMachine`, and run it with each stand-in model:

```ts
test.each(MODELS)("parity with the loop: %s", async (_, model) => {
  const report = await compareRuns({ scenarios: SCENARIOS, baseline: runWith(runLoop, model), candidate: runWith(runMachine, model) });
  const unreviewed = report.scenarios.filter((row) => row.label === "regression" && !REVIEWED[row.id]);
  expect(unreviewed).toEqual([]);
  // A reviewed difference still has to be exactly the difference a person accepted.
  for (const row of report.scenarios.filter((row) => REVIEWED[row.id])) REVIEWED[row.id]!(row);
});

// Effect-only differences a person accepted: who, and the exact difference.
const REVIEWED: Record<string, (row: ParityResult<Scenario>) => void> = {
  // "no-order-id-no-reply": (row) => { /* accepted by <name>: asks once, not three times */ expect(row.candidate.outcome).toBe(row.baseline.outcome); ... },
};
```

- Every `regression` row: fix the machine, or, when the old behavior was wrong but broke no rule, ask the user. If the outcomes differ, the answer may become the scenario's `expected`. If only effects differ (the loop asked three times, the machine once), list the row in a reviewed-differences list in the test, with the exact difference asserted and the person who accepted it. Never edit a scenario to make a row pass.
- Every `intended` row: check that its reason is a real rule. A candidate that fixed a rule break with the same outcome is `intended` too.
- Run once with a live model if a key is available. Report it as one sample, not a guarantee.

## 8. Hand back

Report, in this order:

1. The files: environment, runner, tests (and a policy, if the code had one). The old code is untouched.
2. The rule list from step 1, each mapped to its guard, its state, or the reason it was dropped.
3. The parity table per stand-in model: `same / intended / regression`, and one line per `intended` row with its reason.
4. The `canReach` results and the loosened-guard test.
5. Anything you had to decide that the user should confirm.
6. Next step: `add-traces`.
