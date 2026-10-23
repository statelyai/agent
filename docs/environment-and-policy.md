---
title: Environment and policy
description: Split an agent into a fixed environment that people author and verify, and a policy that a model can write and improve inside it.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

This page explains how to split an agent into two machines: an environment that people own, and a policy that a model can write.

An agent does two kinds of work. It follows the rules of its domain, and it chooses how to make progress within those rules. The two change at different rates and need different owners, so they can live in different machines.

- The **environment** is the rules of the world and the business invariants. People author it in TypeScript, as states and guards, and verify it with [`canReach` and `explorePaths`](verify.md). It is fixed.
- The **policy** is how the agent works toward the goal: which step comes next, which tool to call, when to ask a person, and when a cheap judgment is enough instead of a model call. It is a machine a model can write: a TypeScript `setupAgent` machine, or a JSON `AgentWorkflowConfig` when it must change without a deploy. It is gated before it runs and promoted only on a measured improvement.

The environment is code you own and can verify. The policy is something a model can write inside it.

## The two layers

<!-- viz: two nested boxes: environment (TypeScript, fixed: states, guards, invariant sentinel) asks for one event at each decision point -> policy (TypeScript or JSON machine, improvable: steps, tools, judgments) returns one event -> environment guards accept it or not; traces flow from the environment to an event log store -->

```text
environment (TypeScript, fixed)          policy (TS or JSON, improvable)
  states, guards, invariants   ── asks for one event ──▶  steps, tools, judgments
  accepts the event or not ◀── returns one event ───  ends in a final state
```

| Layer       | Authored by                   | Format                                                         | Changes                         | Checked with                                                                                   |
| ----------- | ----------------------------- | -------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------- |
| Environment | People                        | TypeScript machine                                             | By code review, rarely          | `canReach`, `explorePaths`, unit tests                                                         |
| Policy      | A model, reviewed by a person | TypeScript `setupAgent` machine, or JSON `AgentWorkflowConfig` | Between runs, on measured gains | TS: `tsc`, `lintAgentMachine`, replay, objective; JSON: `verifyAgentConfig`, replay, objective |

- The environment exposes decision points: states where it asks for one event. Its guards decide whether to accept whatever the policy proposes, so a policy cannot take an action the environment forbids.
- The policy answers at those decision points. It can be a single model call, a ladder of `choice` states over the facts, a judgment, or a request to ask the customer. Its final state outputs the event it proposes. The host runs the policy as the environment's `decide` executor, as the [worked example](../examples/self-improving-refunds) does.
- An invariant sentinel, a state that is entered only when a rule is broken, stays unreachable for every policy. `canReach` proves it once, against the environment, for every event sequence and payload variant you list. See [Payloads and invoke outputs](verify.md#payloads-and-invoke-outputs).

The environment can be a plain XState machine. [`decideNext`](decisions.md#decisions-at-the-boundary-of-a-plain-machine) asks a model to pick one event that a plain XState machine accepts right now, and [closed choices](decisions.md#closed-choices) list the concrete events a decider may pick.

### The event vocabulary

The keys of `machine.schemas.events` are the machine's event vocabulary: every event type it declares, in any state. `schemas` is optional in the machine type, so read it with `?.`.

```ts
import { createMachine } from "xstate";
import { z } from "zod";

const refundDesk = createMachine({
  schemas: {
    events: {
      "desk.refund": z.object({ amount: z.number() }),
      "desk.escalate": z.object({}),
    },
  },
  initial: "reviewing",
  states: { reviewing: {} },
});

const vocabulary = Object.keys(refundDesk.schemas?.events ?? {});
// ["desk.refund", "desk.escalate"]
```

- `getAcceptedEvents(snapshot)` lists what one snapshot accepts. The vocabulary is machine-wide and needs no snapshot.
- Gate a policy to it: pass it as `allow.events` to `verifyAgentConfig`, and a candidate whose `agent.decide` lists any other event fails the `vocabulary` gate.
- A `setupAgent` machine also declares the reserved `@agent.usage` event. Drop it with `.filter((type) => !type.startsWith("@agent."))`.

## The goal and the objective

A policy is improved toward something. The machine's `description` states that goal.

- **Goal:** the overall objective in words, with measurable success criteria. For example: "Resolve each refund ticket correctly in one session. Success: the refund issued matches policy, no refund above $100 issues without approval, at most 4 proposals per ticket."
- **Objective:** a function that scores a batch of runs against those criteria. It reads outcomes from ground truth: the environment's terminal states in the traces, or the effects recorded in the world. A model never grades its own runs.
- **Held-out scenarios:** a set of scenarios the improver never sees while it proposes changes. A change is promoted only when it improves the objective on them, so the policy cannot overfit the training scenarios.

`describeMachine` puts the goal first in the text it renders for a model, so a model proposing a change reads the goal before the states. See [Machine descriptions for models](machines-as-data.md#machine-descriptions-for-models).

## Traces

The improver reads past runs. Persist every run to an [event log store](event-log.md) from the first run.

```ts
import { runAgent } from "@statelyai/agent";
import { createInMemoryEventLogStore } from "@statelyai/agent/log";

const store = createInMemoryEventLogStore();

const result = await runAgent(machine, {
  input,
  executors,
  store,
  threadId: "ticket-1001",
});
```

- Each run writes to its own thread. Name threads by split and scenario, such as `train:ticket-1001`, and `store.listThreads({ prefix: "train:" })` pages through one split. `listThreads` is optional on a custom store; without it, record the thread ids per scenario. See [Stores](event-log.md#stores).
- `replay(machine, entries)` from `@statelyai/agent/log` rebuilds the state at the end of a thread, with no model calls. `getUsageFromEvents(entries)` sums its token usage.
- The log also keeps the decision attempts the machine did not accept, on the entry they explain. `getDecisionAttempts(entries)` from `@statelyai/agent/log` lists them with their reasons, so the events the guards refused are countable from the log alone. A host that decides with `decideNext` passes its `attempts` with the event. See [Decision attempts](event-log.md#decision-attempts).
- `createInMemoryEventLogStore` is for tests. In production, implement `AgentEventLogStore` against your database. See [Persistence](persistence.md).

An objective reads the threads and scores them. This one counts correct terminal states, invariant violations, and tokens:

```ts
import { getUsageFromEvents, replay, type AgentEventLogStore } from "@statelyai/agent/log";
import type { AnyStateMachine } from "xstate";

interface Scenario {
  threadId: string;
  expected: "issued" | "escalated" | "closed";
}

async function scoreRuns(
  environment: AnyStateMachine,
  store: AgentEventLogStore,
  scenarios: Scenario[],
) {
  let correct = 0;
  let violations = 0;
  let tokens = 0;
  for (const scenario of scenarios) {
    const entries = await store.read(scenario.threadId);
    const { snapshot } = replay(environment, entries);
    if (snapshot.matches("illegallyIssued")) violations++;
    else if (snapshot.matches(scenario.expected)) correct++;
    tokens += getUsageFromEvents(entries).totalTokens ?? 0;
  }
  return { accuracy: correct / scenarios.length, violations, tokens };
}
```

The expected outcome per scenario is a label people write. The score never comes from a model's opinion of the run.

## The improvement loop

```text
traces → objective → diagnose → propose a policy diff → verifyAgentConfig → replay train → replay held-out → promote or discard
```

<!-- viz: improvement loop: read traces from the event log store -> compute the objective -> diagnose failure clusters -> propose one policy diff -> verifyAgentConfig gates (validate -> vocabulary -> lower -> lint -> explore), failing gate detail feeds back as a repair prompt up to 3 times -> replay train then held-out scenarios -> promote when violations are 0 and held-out improves, else discard; the environment box is outside the loop -->

Each round changes the policy once, then measures it.

1. **Diagnose.** Compute per-run outcomes and the objective. Group the failures by cause: the terminal state reached, guard rejections (`getDecisionAttempts`), loops, and cost hotspots. [`foldTraces`](evals.md#per-state-stats) counts visits, failures, and withheld options per state across runs.
2. **Propose.** A model writes the smallest policy change that addresses one cause, with its hypothesis written down.
3. **Gate.** [`verifyAgentConfig`](generate-machines.md) runs `validate`, `vocabulary`, `lower`, `lint`, and `explore` on the candidate. A failing gate's `detail` is the repair prompt. Cap repairs at 3.
4. **Replay.** Run the training scenarios with the candidate, then the held-out scenarios.
5. **Promote or discard.** Promote only when invariant violations are 0, the objective improves on the held-out scenarios, and no scenario regresses beyond a stated tolerance. Otherwise keep the current policy.

The `vocabulary` gate keeps a candidate inside the environment's contract: it lists the actors, requests, named guards, decision events, and model refs a policy may reference. A candidate that names anything else fails before it runs.

> **Warning:** No machine is edited while it runs. A promoted policy applies to new runs. Runs in progress finish on the version they started with.

## What stays human

People own everything that defines "better" and everything the policy cannot touch.

- The environment: its states, guards, invariants, and the `canReach` proofs behind them.
- The goal, its success criteria, and the objective function. A model can draft an objective from the goal; a person confirms it before it is used.
- The vocabulary a policy may reference.
- The scenario set, the held-out split, and the regression tolerance.
- Environment changes. When the goal is unreachable without one, the improver writes a change request for a person instead of editing the environment.

Self-improvement is a supported pattern with gates. The library supplies the gates; the loop, the objective, and the promotion rule stay with the host.

## When not to split

The split pays off when there is a policy worth learning. Skip it in these cases.

- **A single judgment.** One classification or yes/no check inside a fixed workflow does not need its own machine. Use a [judgment](judgments.md) or a [decision](decisions.md) in the environment.
- **A pure environment.** When every step is dictated by the rules, such as an approval flow or a compensation sequence, there is nothing for a policy to choose. Author one TypeScript machine and verify it.
- **No ground truth.** Without outcomes you can score, improvement has nothing to climb. Collect traces and labels first.

## Related

- [Decisions](decisions.md): closed choices, decision models, and `decideNext` for plain machines.
- [Generating machines with an LLM](generate-machines.md): `verifyAgentConfig` and the repair loop.
- [Machines as data](machines-as-data.md): the config format and `describeMachine`.
- [Testing and verification](verify.md): `canReach`, `explorePaths`, and payload variants.
- [Event log](event-log.md) and [Persistence](persistence.md): stores, threads, and replay.
- The [`graph-engineering`](https://github.com/statelyai/agent/blob/main/skills/graph-engineering/SKILL.md) skill routes existing code to [`loop-to-machine`](https://github.com/statelyai/agent/blob/main/skills/loop-to-machine/SKILL.md), which converts the loop and checks parity with `compareRuns`. It routes new policies to [`generate-machine`](https://github.com/statelyai/agent/blob/main/skills/generate-machine/SKILL.md). Then [`add-traces`](https://github.com/statelyai/agent/blob/main/skills/add-traces/SKILL.md) persists runs, [`add-evals`](https://github.com/statelyai/agent/blob/main/skills/add-evals/SKILL.md) writes evaluations for each state, and [`improve-machine`](https://github.com/statelyai/agent/blob/main/skills/improve-machine/SKILL.md) proposes a pull request from traces, or reports that no candidate beat the current policy.
- [examples/self-improving-refunds](../examples/self-improving-refunds): a refund desk as the environment, JSON playbooks as the policy, an improvement loop, and a benchmark against a raw tool loop.
- [examples/code-review-loop](../examples/code-review-loop): review gates as the environment, a triage policy improved from traces against hidden tests, run with Claude Code in headless mode.
- [examples/tic-tac-toe](../examples/tic-tac-toe): a game as the environment, a policy over board features, and a `canReach` proof that it never loses as the bar for promotion.
