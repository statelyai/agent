---
title: Verify in place
description: Model an existing agent workflow, prove the model's rules, and check recorded runs of the unchanged code against it. Migrating the code to a machine is optional.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

There are two ways to use `@statelyai/agent`:

- **Author** a new workflow as a machine. The machine is the code, and it enforces its rules at runtime. Start with the [Quickstart](quickstart.md).
- **Verify in place.** Keep the code you have, write a model of its control flow, prove the model's rules, and check recorded runs of the code against the model. This page covers that track.

You can migrate the code to a machine later. The model and its proofs carry over. See [Migrate later](#migrate-later).

The worked example is [examples/verify-in-place](https://github.com/statelyai/agent/tree/next/examples/verify-in-place). Every snippet on this page comes from it.

## What you get

- A model file in the repo, reviewed like other code.
- Proofs of the model's rules that run in CI with no model calls.
- A check that recorded runs of the code conform to the model, and a report of the first step where a run does not.
- Coverage: the states and transitions of the model that no recorded run reached.

The claim is: the model is proved, and these recorded runs conform to it. A run you did not record can still break a rule. After a migration, the machine enforces the rules, and the claim covers every run.

## The existing code

The example is a refund agent. Every side effect goes through one `effects` object, and the rules live in `if` statements:

```ts no-check
export async function handleRefundRequest(
  fx: RefundEffects,
  request: { orderId: string; message: string },
): Promise<RefundOutcome> {
  const order = await fx.lookupOrder(request.orderId);
  for (let decisions = 0; decisions < MAX_DECISIONS; decisions++) {
    const decision = await fx.decide({ request: request.message, order, decisions });
    if (decision.type === "reply") return "replied";
    if (decision.type === "investigate") continue;
    if (decision.amount > order.total) return "over-total";
    if (decision.amount > APPROVAL_THRESHOLD) {
      const approved = await fx.requestApproval({
        orderId: order.orderId,
        amount: decision.amount,
      });
      if (!approved) return "declined";
    }
    await fx.issueRefund({ orderId: order.orderId, amount: decision.amount });
    return "refunded";
  }
  return "escalated";
}
```

The check does not edit this file. Code whose side effects are spread across modules needs a seam first: route them through one object, or record them at the client with `createRecorder`'s `recorder.client` or `recorder.model`. See [Evals](evals.md#any-model-client).

## Step 1: the model file

Write the same control flow as a machine in `model.ts`. Each unit of work is an actor declared by name, with a placeholder implementation, so the model runs none of the code. Each rule is a state or a guard:

```ts no-check
deciding: {
  invoke: {
    src: "decide",
    input: ({ context }) => ({ decisions: context.decisions }),
    onDone: ({ context, event }) => {
      const decision = event.output;
      const decisions = context.decisions + 1;
      if (decision.type === "reply") return { target: "replied", context: { decisions } };
      if (decision.type === "investigate")
        return { target: "checking", context: { decisions } };
      const amount = decision.amount;
      if (amount > context.order!.total)
        return { target: "overTotal", context: { decisions, amount } };
      return amount > APPROVAL_THRESHOLD
        ? { target: "awaitingApproval", context: { decisions, amount } }
        : { target: "refunding", context: { decisions, amount } };
    },
  },
},
awaitingApproval: {
  on: {
    APPROVE: { target: "refunding", context: { approved: true } },
    REJECT: { target: "declined" },
  },
},
```

- Declare every actor in `setupAgent({ actors })` and invoke it by `src`. `checkConformance` answers named actors from the recording, and rejects a model whose invoke names its logic inline.
- A person's input, such as an approval, is an event the model waits for in an idle state.
- The `stately` skill in [statelyai/skills](https://github.com/statelyai/skills) can draft a model from code. Review it like code: the proofs below hold for the model, not for behavior the model leaves out.

## Step 2: proofs

Prove the model's rules with `canReach`, as ordinary tests. Give each actor the outputs it can return:

```ts no-check
const proofOptions = {
  input: { orderId: "P-1" },
  outputs: {
    lookupOrder: [{ orderId: "P-1", total: 300 }],
    decide: [
      { type: "refund", amount: 50 },
      { type: "refund", amount: 250 },
      { type: "refund", amount: 400 },
      { type: "reply", message: "ok" },
      { type: "investigate" },
    ],
    issueRefund: [undefined],
  },
  maxDepth: 12,
};

const result = await canReach(
  refundModel,
  (snapshot) =>
    snapshot.matches("refunding") &&
    snapshot.context.amount > APPROVAL_THRESHOLD &&
    !snapshot.context.approved,
  proofOptions,
);
// { reachable: false, complete: true }
```

- `reachable: false` is a proof only with `complete: true`.
- Check that the search reaches the path the rule guards, for example a large refund through approval. Otherwise a model where that path does not exist proves the rule vacuously.
- See [Testing and verification](verify.md#reachability-checks) for payloads, ordering targets, and bounds.

## Step 3: record runs of the code

Wrap each function of the `effects` object with `recorder.fn` and run the code as it is:

```ts no-check
const recorder = createRecorder();
await handleRefundRequest(
  {
    lookupOrder: recorder.fn("lookupOrder", lookupOrder),
    decide: recorder.fn("decide", decide),
    requestApproval: recorder.fn("requestApproval", requestApproval),
    issueRefund: recorder.fn("issueRefund", issueRefund),
  },
  request,
);
const recording = recorder.recording;
```

The example records scripted scenarios with stand-in functions. A recording from a real run works the same way; save it as JSON and check it later.

## Step 4: map recorded calls to observations

An observation is one thing the run did, in the model's terms. Map the recording's effects with `flatMap`:

```ts no-check
function toObservations(recording: Recording): Observation[] {
  return recording.effects.flatMap((effect): Observation[] => {
    if (effect.kind !== "call") return [];
    switch (effect.name) {
      case "lookupOrder":
        return [{ kind: "lookup", order: effect.result as Order }];
      case "decide":
        return [{ kind: "decision", decision: effect.result as Decision }];
      case "requestApproval":
        return [{ kind: "approval", approved: effect.result as boolean }];
      case "issueRefund":
        return [{ kind: "refund", amount: (effect.args as [{ amount: number }])[0].amount }];
      default:
        return [];
    }
  });
}
```

Keep the mapping to what the call shows. Do not decide in the mapping what the code should have done next: that is the model's job, and a mapping that repeats the code's logic makes the check pass for any run.

## Step 5: check conformance

`checkConformance` runs the model with each actor answered from the observations:

```ts no-check
const report = await checkConformance(refundModel, {
  input: { orderId: scenario.order.orderId },
  observations: toObservations(recording),
  actors: {
    lookupOrder: { observes: "lookup", output: ({ observation }) => observation.order },
    decide: { observes: "decision", output: ({ observation }) => observation.decision },
    issueRefund: {
      observes: "refund",
      matches: ({ input, observation }) => input.amount === observation.amount,
    },
  },
  events: {
    approval: (observation) => ({ type: observation.approved ? "APPROVE" : "REJECT" }),
  },
});
```

- An actor with `observes` consumes the next observation, which must be of that kind. `output` builds the actor's output from it.
- `matches` compares the actor's input with the observation. Here, the refund the code issued must be the amount the model would refund.
- `events` sends an observation to the model as an event while the model waits, here the person's approval.
- An actor the recording cannot see takes no `observes`. It runs unchecked and is listed in `report.unobserved`.
- When an actor's output carries state the recording does not show, build it in `output` from the model's own `input` plus the observation.

All runs of the unchanged code conform. The full option and deviation reference is in [Testing and verification](verify.md#recorded-runs-against-a-model).

## Step 6: coverage

Pass each report's `trace` to `traceCoverage`:

```ts no-check
const coverage = traceCoverage(refundModel, reports.map((report) => report.trace));
coverage.unvisitedStates; // []
coverage.unvisitedHandlers; // transitions no recorded run took
```

An unvisited state or handler is a part of the model no recorded run exercised. Add a scenario that reaches it, or confirm that it cannot happen in production.

## A regression, caught

`regression.ts` is the code after a plausible change: repeat customers skip approval on refunds up to twice the threshold. The happy-path tests still pass. The conformance check reports:

```ts no-check
{
  reason: "extra-observations",
  expected: "idle, waiting for an event",
  observed: { kind: "refund", amount: 150 },
  state: "awaitingApproval",
}
```

The model was waiting for a person in `awaitingApproval`, and the code issued the refund instead. Only the scenario with a repeat customer and a mid-size refund shows it. The check finds a bug only on a run that exercises it. Coverage shows which parts of the model the recorded runs exercised.

## What the check covers

- It checks the order and the content of what the recording shows against what the model allows.
- It does not see effects the recording does not capture. An actor without `observes` is unchecked, and the report lists it.
- It does not prove anything about runs you did not record. The proofs on the model cover every path of the model; conformance ties those paths to the recorded runs.
- A wrong model can conform and prove its rules. Review the model, and treat a deviation as a question about the code or the model.

## Migrate later

When you want the rules enforced at runtime instead of checked after the fact, migrate the code to a machine. The model becomes the machine, its placeholder actors become the code's functions, and the same proofs run against it.

- [Migrating from a hand-rolled loop](from-a-loop.md) walks through a migration.
- The [`loop-to-machine`](https://github.com/statelyai/skills/blob/main/plugins/stately-agent/skills/loop-to-machine/SKILL.md) skill runs it with a coding agent.
- `checkParity` checks the migrated machine against the original code. See [Strangler-fig retrofit](strangler-fig.md#check-parity).

## Related

- [Testing and verification](verify.md): `canReach`, `explorePaths`, and the `checkConformance` reference.
- [Evals](evals.md): `traceCoverage`, recorders, and parity.
- [examples/verify-in-place](https://github.com/statelyai/agent/tree/next/examples/verify-in-place): the code on this page, with tests.
