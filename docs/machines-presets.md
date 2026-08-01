---
title: Preset machines
description: Factories for proven agent shapes — tool loop, sequential, router, parallel, loop, supervisor, handoff — that return ordinary, inspectable agent machines.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

## Overview

`@statelyai/agent/machines` ships factories for the agent shapes that every framework converges on. Each one is a thin composition over `setupAgent(...).createMachine(...)`:

- The result is an **ordinary machine**. Same states, same guards, same snapshots, same `lintAgentMachine`.
- **Executors stay separate.** Presets name no SDK; the host still passes `executors` to `runAgent`/`generateResult`.
- **Nothing is hidden.** Every preset is ~100 lines of visible states you can read, diagram, and eject from.

```ts
import { runAgent } from "@statelyai/agent";
import { createToolLoopMachine } from "@statelyai/agent/machines";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";

const models = defineModels({ quick: openai("gpt-5.4-mini") });

const machine = createToolLoopMachine({
  model: "quick",
  instructions: "Answer using the tools.",
  tools: { calculate },
  maxTurns: 5,
});

const result = await runAgent(machine, {
  input: { prompt: "What is 42 times 17?" },
  executors: createAiSdkExecutors({ models }),
});
// Snapshots and log entries carry machine.version ("1") automatically.
```

## The taxonomy

Three questions separate the seven presets:

- **Who runs the work?** One request (`toolLoop`), a fixed chain (`sequential`), or named sub-units (the rest).
- **Who picks the next unit?** The author (`sequential`, `parallel`, `loop`) or the model (`router`, `supervisor`, `handoff`).
- **Does control come back?** Delegation returns (`supervisor`); routing ends the run (`router`); handoff transfers for good (`handoff`).

| Preset | Shape | Model chooses | Control returns |
| --- | --- | --- | --- |
| `createToolLoopMachine` | One request, host-run tool loop | tools | n/a |
| `createSequentialMachine` | Prompt chain, step by step | nothing | n/a |
| `createRouterMachine` | One decision picks one destination | the route | no, the run ends there |
| `createParallelMachine` | Static fan-out, joined | nothing | yes, at the join |
| `createLoopMachine` | Bounded repeat | nothing | yes, each iteration |
| `createSupervisorMachine` | Delegate, accumulate, repeat | the worker, or `FINISH` | yes, every turn |
| `createHandoffMachine` | Peer swarm, `activeAgent` holds the mic | n/a (host sends `transfer_to_*`) | no, transfer is final |

## Config names

Every preset uses the same vocabulary:

- `model`: model ref or `models` alias. Entry-level `model` overrides the factory default.
- `instructions`: the system prompt.
- `tools`: tools the host runs inside one request.
- `outputSchema`: structured output. Omitted means plain text.
- `maxTurns` / `maxIterations`: the bound. `maxTurns` lowers to `metadata.maxSteps` for a request; `maxIterations` is a machine guard.
- `interruptOn`: tool names the host should gate (tool-loop only).
- Worker/route/branch/agent entries are a record: the key is the `name`, and each entry carries a `description` the deciding model reads.

An entry is either an inline request (`{ description, instructions, model, outputSchema, tools }`) or a child machine (`{ description, machine, input? }`). Child machines are registered as actor sources, so `runAgent` binds their executors too.

## The presets

### `createToolLoopMachine`

One text request carries the `tools`; the host runs the tool loop inside it. `maxTurns` bounds it via `metadata.maxSteps`. States: `answering` → `done`.

This is the default for tool use. `interruptOn` is passed through as `metadata.interruptOn` for hosts that gate tool execution; it does not add machine states. For a real approval gate as states, eject (see below).

### `createSequentialMachine`

A prompt chain: one state per step, each step's output feeding the next. A step's `prompt(ctx)` can read `{ prompt, results, previous }`; without one, the default prompt is the previous step's output.

### `createRouterMachine`

One `agent.decide` picks exactly one declared route (`ROUTE_<name>`; build the string with `routeEventType(name)` when sending or asserting these events), then the machine runs it. Undeclared routes have no event, no state, and no transition, so they cannot be taken. Add `fallback` to land somewhere when the decision fails; without it, a failed decision errors the run.

### `createParallelMachine`

Static fan-out: one region per branch, all concurrent, joined into a keyed `results` object. Branch count is fixed at author time. For an N decided at run time, see [examples/fan-out](../examples/fan-out/index.ts).

### `createLoopMachine`

A bounded repeat: run `body`, check `until` over `{ prompt, iterations, results, last }`, go again or stop. `maxIterations` is a guard, so the loop cannot run away even if `until` never fires.

### `createSupervisorMachine`

Each turn, one `agent.decide` picks a worker (`DELEGATE_<name>`, via `delegateEventType(name)`) or `FINISH` (`FINISH_EVENT_TYPE`). Results accumulate in context and are rendered back into the next decision. A spent `maxTurns` budget removes every delegate from the candidate set and a guard rejects one anyway.

### `createHandoffMachine`

Peer swarm: `context.activeAgent` holds the mic, runs one turn, and the machine settles idle in `waiting`. A `transfer_to_<name>` event (via `transferEventType(name)`) moves the mic and re-routes. There is no final state: the conversation ends when the host stops resuming it. Persist the idle snapshot between turns.

## Versioning

Every preset machine carries `version: "1"` — XState's standard `createMachine({ version })` prop. `runAgent` reads it automatically (resolution: `options.machineVersion` → `machine.version` → structural hash), so snapshots, event-log entries, and trace events are stamped with `"1"` and stay resumable across releases:

```ts
const result = await runAgent(machine, { input, executors });
// result.events[0].machineVersion === "1"
```

The policy:

- The version identifies the machine's **topology**, not the release that built it. Internals may be refactored (prompt wording, an added `onError`, a renamed internal id) without a bump, so persisted snapshots and event logs stay valid.
- A topology change that a persisted snapshot could not resume into bumps the machine version (`"2"`) — a minor package release at most. Resume across the bump via `migrateSnapshot`/`onVersionMismatch`.

The same prop works for your own machines: set `version` in `createMachine(...)` and `runAgent` stamps it instead of the structural hash (which changes on any edit).

## Ejecting

A preset is a starting point, not a framework. When you need one more state, a human gate, a different bound, or typed context of your own:

- Open the preset's source (`src/machines/<preset>.ts`) — it is one small file of visible states.
- Copy it into your project and edit the `setupAgent(...)` call directly.
- Nothing else changes: the copied machine runs the same way, lints the same way, and persists the same way.

Related examples to eject toward: [react-agent](../examples/react-agent/index.ts) (tool loop as states), [review-tool-calls](../examples/review-tool-calls/index.ts) (approval gate), [fan-out](../examples/fan-out/index.ts) (dynamic N), [reflection-writer](../examples/reflection-writer/index.ts) (critique loop), [supervisor](../examples/supervisor/index.ts), [swarm-handoff](../examples/swarm-handoff/index.ts).

## Where to go next

- [Agent machines](machines.md): what the presets compose — `setupAgent`, states, invokes, guards.
- [Agent patterns](patterns.md): the full runnable example catalog.
- [The event log](event-log.md): where `machineVersion` is recorded and checked.
