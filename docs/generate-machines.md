---
title: Generating machines with an LLM
description: Have a model author the agent workflow itself, then run the generated config through every pre-run gate before a single model call runs inside it.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

This page covers having a model author an agent machine config, then checking that config with `verifyAgentConfig` before it runs.

An agent machine is [data](machines-as-data.md), so a model can write one. A generated machine can be checked before it runs, at several gates.

<!-- static lint diagnostics from src/verify.ts -->

- The config's shape is fixed by a JSON Schema that ships with the package. Expressions are dot paths, not code, so a generated config cannot do anything a hand-authored machine could not do.
- `verifyAgentConfig` runs every pre-run gate in one call and returns a record per gate. It is exported from `@statelyai/agent/validate`, which uses `ajv` as an optional peer dependency, so install `ajv` to use it.
- The gates check the config's shape, the names it references, the lowering, Agent lint and the config's state graph, and every explored path. Use [`canReach` and `explorePaths`](verify.md) directly for other reachability questions.
- Replay against real scenarios and scoring are domain-specific. They stay with the caller, after the gates pass.

## The loop

```
generate → verifyAgentConfig (validate → vocabulary → lower → lint → explore) → run
```

<!-- viz: generation pipeline: generate -> verifyAgentConfig gates (validate -> vocabulary -> lower -> lint -> explore) -> run, with each failing gate feeding back into generate as a repair prompt, capped at 3 attempts -->

| Gate         | Checks with                                    | Fails on                                                                                                                                                                                         |
| ------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `validate`   | `validateAgentConfig`                          | malformed config shape                                                                                                                                                                           |
| `vocabulary` | the `allow` lists                              | an invoke src, guard, action, `agent.decide` event, or model ref outside the vocabulary                                                                                                          |
| `lower`      | `setupAgent.fromConfig`                        | unresolved named guards/actions, `onDone` on a decision                                                                                                                                          |
| `lint`       | `lintAgentMachine`, config graph checks        | decisions with no handled events, unreachable states, states that cannot reach a final state, decision events with no handler or no payload schema; warnings too with `lint: { warnings: true }` |
| `explore`    | `explorePaths`, once per `explore.inputs` item | a path ending outside `explore.terminals`, a loop past `maxDepth`, a `maxPaths`/`maxNodes` cap, untried payloads (`unexpandedEvents`)                                                            |

A workflow with a legitimate loop (a resent code, a requested change, a chat follow-up) needs `explore.dedupeBy`, or every pass around the loop is a new path and exploration hits `maxDepth`. With `dedupeBy`, exploration visits each projected snapshot once, so it no longer reports a loop that never ends. The `lint` gate covers that case from the config graph: `state-cannot-finish` names every reachable leaf state with no path to a final state.

The `lint` gate adds these checks over the config's state graph to `lintAgentMachine`. Each is an error.

| Code                          | Fails on                                                                                                                                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unreachable-state`           | a state that is not an initial state and that no transition from a reachable state targets                                                                                                                  |
| `state-cannot-finish`         | a reachable leaf state with no path to a final state through events, `after`, `always`, choice branches, or invoke results. A stuck compound state is reported as its stuck child, such as `review.waiting` |
| `decide-event-unhandled`      | an exact `allowedEvents` entry that no state handles with that exact key: not the deciding state, an ancestor, a descendant, or another parallel region                                                     |
| `decide-event-without-schema` | an event a decision may send with no `schemas.events` entry, so its payload reaches the machine unvalidated                                                                                                 |

Guards are ignored, so the graph checks report a state only when no path exists at all. A config with no final state is treated as a long-running service and skips `state-cannot-finish`. The decision checks read the states that can be active with the deciding state: the state itself, its ancestors, its descendants, and the other regions of a parallel ancestor. An `agent.decide` or `agent.act` invoke with no `allowedEvents` may send every non-human event those states handle, so each of those needs a schema. An event is human when any transition on its exact key is tagged `meta: { actor: "human" }`. A human-tagged `"desk.*"` handler does not make `"desk.close"` human. A wildcard entry such as `"desk.*"` stands for every matching event those states handle. An exact entry such as `"desk.close"` needs an `on` key with that exact type: an `on["desk.*"]` handler does not count, because the runtime does not offer it for an exact entry. `agent.decide` `payloads` listed for an event close the choice, so that event needs no schema. `agent.act` ignores `payloads`. A `{{ }}` template in `allowedEvents` resolves at run time, so the decision checks skip that invoke. Give an event with no payload `{ "type": "object", "properties": {} }`.

Run the gates on the config the model returned:

```ts no-check
import { verifyAgentConfig } from "@statelyai/agent/validate";

const result = await verifyAgentConfig(candidate, {
  compileSchema,
  guards: { isLarge: ({ context }) => context.amount > 100 },
  allow: {
    actors: [],
    requests: ["draftReply"],
    guards: ["isLarge"],
    actions: [],
    events: ["APPROVE", "DENY"],
    models: ["openai/gpt-6-luna"],
  },
  explore: {
    inputs: [{ amount: 5 }, { amount: 500 }],
    outputs: { draftReply: [{ reply: "stub" }] },
  },
});

if (!result.ok) {
  const failed = result.gates.find((gate) => !gate.ok)!;
  // Feed this back to the model as a repair prompt.
  feedback.push(`gate '${failed.name}' failed: ${failed.detail}`);
}
```

`compileSchema` is the JSON Schema compiler `fromConfig` uses for the config's schemas. Build it from `ajv`. See [Machines as data](machines-as-data.md).

The result behaves as follows.

- `result.gates` lists the gates that ran, in order. Each is `{ name, ok, detail? }`. The gates stop at the first failure, so a failing gate is always the last entry.
- `detail` names the offending path, state, or name, one problem per line. A passing `lint` gate carries its warnings in `detail`.
- `result.config` is the typed config once `validate` passes. `result.machine` is the lowered machine once `lower` passes.
- `result.explore` holds one `explorePaths` report per `explore.inputs` entry once every input returns a report, even when those reports fail the `explore` gate. Extra checks can read the explored paths without exploring again. It is absent when `explore` is omitted, when `explore.inputs` is empty, or when an input throws.
- `lint.terminalStates` lists non-final states that may wait forever on purpose, such as a case parked for a person who may never act. `state-cannot-finish` treats them as finishing.
- A config that throws while lowering is reported as a failed `lower` gate. `verifyAgentConfig` does not throw on a bad config.
- An omitted `allow` key is unrestricted. Omit `allow` to skip the `vocabulary` gate, and omit `explore` to skip the `explore` gate. An empty `explore.inputs` list fails the `explore` gate.
- An invoke can name only an `agent.*` builtin or a key the config declares under `requests` or `actors`. Any other src fails the `lower` gate, even when `actors` binds it. `allow.requests` limits the declared request keys, and `allow.actors` limits the declared actor keys. With `allow.actors` listed, every non-builtin src must be in `allow.actors` or `allow.requests`, or be a declared request when `allow.requests` is omitted.
- With `allow` given, a raw xstate expression slot (`{ "@expr": ... }`) anywhere in the config fails the `vocabulary` gate. xstate evaluates the slot in place of its literal siblings, so it could hide a model ref or `allowedEvents`. Write `{{ }}` templates instead.
- `explore.terminals` defaults to `['done']`. Other `explore` keys, such as `outputs`, `errors`, `payloads`, `dedupeBy`, `maxPaths`, and `maxNodes`, pass through to `explorePaths`. Script text requests and invoked actors with `outputs`. See [Payloads and invoke outputs](verify.md#payloads-and-invoke-outputs).
- `actors` are bound with `machine.provide({ actors })` after lowering. `guards` and `actions` go to `fromConfig`.
- No gate needs an API key.
- `validateAgentConfig(config)` runs the `validate` gate alone. It returns `{ valid, errors }`, and each error's `path` is a JSON Pointer into the config.

## The repair loop

A failed gate's `detail` is the repair prompt. Send it back to the model with the config it rejected, and run the gates again on the new config.

- Cap the repair loop at about 3 attempts. A config that fails three schema-shaped repairs usually asks for something the data form cannot express. In that case, [author it in TypeScript](machines.md) instead.
- Replay the passing config against your own scenarios before promoting it. `simulateAgent` plays one scripted path with canned responses and no API key.

## The skill

The full authoring procedure is an agent skill in [statelyai/skills](https://github.com/statelyai/skills). It covers the environment and policy split, the schema location, the rules a config must follow, a few-shot config, the Ajv adapter, `verifyAgentConfig`, the repair loop, and persisting traces.

**[`generate-machine`](https://github.com/statelyai/skills/blob/main/plugins/stately-agent/skills/generate-machine/SKILL.md)**

Install it with `npx skills add statelyai/skills --skill generate-machine`, or in Claude Code with `/plugin install stately-agent@stately` after `/plugin marketplace add statelyai/skills`. The agent then loads the skill on requests such as "author an agent machine for X" and runs the gates itself.

To improve a generated policy from its run traces, use [`improve-machine`](https://github.com/statelyai/skills/blob/main/plugins/stately-agent/skills/improve-machine/SKILL.md). See [Environment and policy](environment-and-policy.md).

## Limits

Generated machines have these constraints.

- Named guards and actions are resolved by the host. A config cannot carry functions. A model can emit `guard: "isReady"`, but the implementation lives in the `guards` option passed to `fromConfig(...)`, and an unresolved name throws at build time. List the names your host implements in the prompt, or forbid named references entirely.
- Schema validity is not semantic validity. The schema constrains shape, not meaning. A config can validate and still reference a request that does not exist, or route to a state with no way out. The `vocabulary` gate covers names, and `lint` covers states that are unreachable or have no path to a final state.
- A path to a final state is not a guarantee that a run takes it. An unguarded retry loop with an exit passes `lint`, and with `dedupeBy` it passes `explore` too. Bound loops with a counter and a guard, or unroll a fixed number of attempts.
- Domain rules stay with the caller. A refund issued without an amount guard passes every gate. Check rules like that with [`canReach`](verify.md#reachability-checks) after the gates pass.
- Exploration covers the inputs you give it. List inputs that reach every branch you care about in `explore.inputs`.
- Model refs resolve at run time, in the host. `allow.models` restricts them to literal strings you list; tool names stay unchecked. Generated machines carry string refs, so pass `createAiSdkExecutors({ resolveModel })`. See [Models and providers](models-and-providers.md). The ref `"openai/gpt-6-luna"` used on this page is illustrative. Substitute your provider's current models.

## Related

- [Machines as data](machines-as-data.md): the config format, its expressions, and its limits.
- [Testing and verification](verify.md): every check and simulation API in full.
- [examples/json-agent](https://github.com/statelyai/agent/blob/next/examples/json-agent/index.ts): a hand-written config, run.
