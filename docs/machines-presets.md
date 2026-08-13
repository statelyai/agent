---
title: Preset machines
description: Factories for proven agent shapes (tool loop, sequential, router, parallel, loop, supervisor, handoff) that return ordinary, inspectable agent machines.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

## Overview

`@statelyai/agent/machines` ships factories for common agent shapes. Each factory is a thin composition over `setupAgent(...).createMachine(...)`.

- The result is an ordinary machine, with the same states, guards, snapshots, and `lintAgentMachine` support as a machine you write yourself.
- Executors stay separate. Presets name no SDK, so the host still passes `executors` to `runAgent` or `generateResult`.
- Each preset is around 100 lines of states that you can read, diagram, and copy into your own project.

```ts
import { tool } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { runAgent } from "@statelyai/agent";
import { createToolLoopMachine } from "@statelyai/agent/machines";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";

// Model IDs here are illustrative; substitute your provider's current models.
const models = defineModels({ quick: openai("gpt-5.4-mini") });

const calculate = tool({
  description: "Evaluate an arithmetic expression.",
  inputSchema: z.object({ expression: z.string() }),
  execute: async ({ expression }) => Number(expression),
});

const machine = createToolLoopMachine({
  model: "quick",
  instructions: "Answer using the tools.",
  tools: { calculate },
  maxSteps: 5,
});

const result = await runAgent(machine, {
  input: { prompt: "What is 42 times 17?" },
  executors: createAiSdkExecutors({ models }),
});
```

Snapshots and log entries carry `machine.version` automatically. See [Versioning](#versioning).

## Preset taxonomy

Three questions separate the seven presets:

- Who runs the work? One request in `toolLoop`, a fixed chain in `sequential`, or named sub-units in the rest.
- Who picks the next unit? The author in `sequential`, `parallel`, and `loop`. The model in `router`, `supervisor`, and `handoff`.
- Does control come back? Delegation returns in `supervisor`. Routing ends the run in `router`. Handoff transfers control permanently in `handoff`.

| Preset                    | Shape                                   | Model chooses                    | Control returns        |
| ------------------------- | --------------------------------------- | -------------------------------- | ---------------------- |
| `createToolLoopMachine`   | One request, host-run tool loop         | tools                            | n/a                    |
| `createSequentialMachine` | Prompt chain, step by step              | nothing                          | n/a                    |
| `createRouterMachine`     | One decision picks one destination      | the route                        | no, the run ends there |
| `createParallelMachine`   | Static fan-out, joined                  | nothing                          | yes, at the join       |
| `createLoopMachine`       | Bounded repeat                          | nothing                          | yes, each iteration    |
| `createSupervisorMachine` | Delegate, accumulate, repeat            | the worker, or `FINISH`          | yes, every turn        |
| `createHandoffMachine`    | Peer swarm, `activeAgent` names the agent that runs the turn | n/a (host sends `transfer_to_*`) | no, transfer is final  |

## Config names

Every preset uses the same vocabulary:

| Option | Meaning |
| ------ | ------- |
| `model` | A model ref or a `models` alias. A `model` on an entry overrides the factory default. |
| `instructions` | The system prompt. |
| `tools` | Tools the host runs inside one request. |
| `outputSchema` | Structured output. Omit it for plain text. |
| `maxSteps` | The bound on a request's host-side tool loop. It lowers to the request's typed `maxSteps`. |
| `maxTurns` | The bound on a machine loop or delegation count. It is enforced by a guard. |

Worker, route, branch, and agent entries are a record. The key is the entry's `name`, and each entry carries a `description` that the deciding model reads.

An entry is either an inline request, written as `{ description, instructions, model, outputSchema, tools }`, or a child machine, written as `{ description, machine, input? }`. Child machines are registered as actor sources, so `runAgent` binds their executors too.

## The presets

### `createToolLoopMachine`

One text request carries the `tools`, and the host runs the tool loop inside that request. `maxSteps` bounds the loop through the request's typed `maxSteps` field. The states are `answering` and `done`.

This preset is the default for tool use. It does not add machine states, and it sets no request `metadata`. To model an approval gate as states, eject. See [Ejection](#ejection).

### `createSequentialMachine`

A prompt chain with one state per step. Each step's output feeds the next step. A step's `prompt(ctx)` can read `{ prompt, results, previous }`. Without a `prompt`, the step's default prompt is the previous step's output.

<!-- viz: state diagram of createSequentialMachine: step1 -> step2 -> step3 -> done, each step invoking one request and writing into results -->

### `createRouterMachine`

One `agent.decide` picks exactly one declared route, then the machine runs it. Route events are named `ROUTE_<name>`. Build the string with `routeEventType(name)` when you send or assert these events. Undeclared routes have no event, no state, and no transition, so the model cannot take them. Add `fallback` to target a state when the decision fails. Without `fallback`, a failed decision errors the run.

<!-- viz: state diagram of createRouterMachine: routing state invoking agent.decide, one ROUTE_<name> transition per declared route, plus the optional fallback target -->

### `createParallelMachine`

Static fan-out with one region per branch. All branches run concurrently and join into a keyed `results` object. The branch count is fixed at author time. For a branch count decided at run time, see [examples/fan-out](../examples/fan-out/index.ts).

<!-- viz: state diagram of createParallelMachine: parallel state with one region per branch, all joining into a single done state with keyed results -->

### `createLoopMachine`

A bounded repeat. The machine runs `body`, evaluates `until` over `{ prompt, iterations, results, last }`, then repeats or stops. `maxTurns` is a guard, so the loop terminates even if `until` never returns true.

### `createSupervisorMachine`

Each turn, one `agent.decide` picks a worker or finishes. `maxTurns` bounds the delegations and defaults to 6. It is a machine budget, and it never lowers a request's `maxSteps`. Worker events are named `DELEGATE_<name>`, built with `delegateEventType(name)`. The finish event is `FINISH`, exported as `FINISH_EVENT_TYPE`. Results accumulate in context and are rendered into the next decision. When the `maxTurns` budget is spent, every delegate is removed from the candidate set, and a guard rejects a delegate event if one is chosen anyway.

<!-- viz: state diagram of createSupervisorMachine: deciding -> DELEGATE_<name> -> worker state -> back to deciding, with FINISH -> done and the maxTurns guard -->

### `createHandoffMachine`

A peer swarm. `context.activeAgent` names the agent that runs the current turn. After the turn, the machine settles idle in `waiting`. A `transfer_to_<name>` event, built with `transferEventType(name)`, changes `activeAgent` and re-routes. There is no final state. The conversation ends when the host stops resuming it. Persist the idle snapshot between turns.

## Ejection

A preset is a starting point. When you need one more state, a human gate, a different bound, or your own typed context:

1. Open the preset's source at `src/machines/<preset>.ts`. It is one small file of states.
2. Copy it into your project and edit the `setupAgent(...)` call directly.
3. Run it as before. The copied machine runs, lints, and persists the same way.

Examples to eject toward:

- [react-agent](../examples/react-agent/index.ts): the tool loop expressed as states.
- [review-tool-calls](../examples/review-tool-calls/index.ts): an approval gate.
- [fan-out](../examples/fan-out/index.ts): a branch count decided at run time.
- [reflection-writer](../examples/reflection-writer/index.ts): a critique loop.
- [supervisor](../examples/supervisor/index.ts) and [swarm-handoff](../examples/swarm-handoff/index.ts): multi-agent topologies.

## Versioning

Every preset machine carries `version: "1"`, using XState's standard `createMachine({ version })` prop. This is the machine's own topology version. It is unrelated to the `@statelyai/agent` package version. `runAgent` reads `machine.version`, and falls back to a structural hash only for a machine that declares no version. Snapshots, event-log entries, and trace events are stamped with `"1"` and stay resumable across releases:

```ts
const result = await runAgent(machine, { input, executors });
// result.events[0].machineVersion === "1"
```

The versioning policy:

- The version identifies the machine's topology, not the release that built it. Internals can be refactored without a version bump, including prompt wording, an added `onError`, or a renamed internal id. Persisted snapshots and event logs stay valid.
- A topology change that a persisted snapshot could not resume into bumps the machine version to `"2"`, in a minor package release at most. Resume across the bump with `migrateSnapshot` or `onVersionMismatch`.

The same prop works for your own machines. Set `version` in `createMachine(...)` and `runAgent` stamps that value instead of the structural hash, which changes on any edit.

## Related

- Read more about [Agent machines](machines.md), including `setupAgent`, states, invokes, and guards.
- Read more about [Agent patterns](patterns.md), the full runnable example catalog.
- Read more about [The event log](event-log.md), where `machineVersion` is recorded and checked.
