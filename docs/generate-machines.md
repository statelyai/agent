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
- The gates check the config's shape, the names it references, the lowering, Agent lint, and every explored path. Use [`canReach` and `explorePaths`](verify.md) directly for other reachability questions.
- Replay against real scenarios and scoring are domain-specific. They stay with the caller, after the gates pass.

## The loop

```
generate → verifyAgentConfig (validate → vocabulary → lower → lint → explore) → run
```

<!-- viz: generation pipeline: generate -> verifyAgentConfig gates (validate -> vocabulary -> lower -> lint -> explore) -> run, with each failing gate feeding back into generate as a repair prompt, capped at 3 attempts -->

| Gate         | Checks with                                    | Fails on                                                                                  |
| ------------ | ---------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `validate`   | `validateAgentConfig`                          | malformed config shape                                                                    |
| `vocabulary` | the `allow` lists                              | an invoke src, guard, action, `agent.decide` event, or model ref outside the vocabulary   |
| `lower`      | `setupAgent.fromConfig`                        | unresolved named guards/actions, `onDone` on a decision                                   |
| `lint`       | `lintAgentMachine`                             | decisions with no handled events; warnings too with `lint: { warnings: true }`            |
| `explore`    | `explorePaths`, once per `explore.inputs` item | a path that ends outside `explore.terminals`, loops past `maxDepth`, or hits the path cap |

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
    models: ["openai/gpt-5.4-mini"],
  },
  explore: {
    inputs: [{ amount: 5 }, { amount: 500 }],
    text: { draftReply: { reply: "stub" } },
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
- A config that throws while lowering is reported as a failed `lower` gate. `verifyAgentConfig` does not throw on a bad config.
- An omitted `allow` key is unrestricted. Omit `allow` to skip the `vocabulary` gate, and omit `explore` to skip the `explore` gate.
- `explore.terminals` defaults to `['done']`. Other `explore` keys, such as `text`, `invokes`, `errors`, and `maxPaths`, pass through to `explorePaths`.
- `actors` are bound with `machine.provide({ actors })` after lowering. `guards` and `actions` go to `fromConfig`.
- No gate needs an API key.
- `validateAgentConfig(config)` runs the `validate` gate alone. It returns `{ valid, errors }`, and each error's `path` is a JSON Pointer into the config.

## The repair loop

A failed gate's `detail` is the repair prompt. Send it back to the model with the config it rejected, and run the gates again on the new config.

- Cap the repair loop at about 3 attempts. A config that fails three schema-shaped repairs usually asks for something the data form cannot express. In that case, [author it in TypeScript](machines.md) instead.
- Replay the passing config against your own scenarios before promoting it. `simulateAgent` plays one scripted path with canned responses and no API key.

## The skill

The full authoring procedure ships as an agent skill. It covers the schema location, the rules a config must follow, a few-shot config, the Ajv adapter, the lint and simulate calls, and the repair loop.

**[`skills/generate-machine/SKILL.md`](https://github.com/statelyai/agent/blob/main/skills/generate-machine/SKILL.md)**

Copy that directory into your coding agent's skills directory. For Claude Code this is `.claude/skills/`. Other harnesses use their own location. The agent then loads the skill on requests such as "author an agent machine for X" and runs the gates itself.

## Limits

Generated machines have these constraints.

- Named guards and actions are resolved by the host. A config cannot carry functions. A model can emit `guard: "isReady"`, but the implementation lives in the `guards` option passed to `fromConfig(...)`, and an unresolved name throws at build time. List the names your host implements in the prompt, or forbid named references entirely.
- Schema validity is not semantic validity. The schema constrains shape, not meaning. A config can validate and still reference a request that does not exist, or route to a state that does not make progress. The `vocabulary`, `lint`, and `explore` gates cover those cases.
- Exploration covers the inputs you give it. List inputs that reach every branch you care about in `explore.inputs`.
- Model refs resolve at run time, in the host. `allow.models` restricts them to literal strings you list; tool names stay unchecked. Generated machines carry string refs, so pass `createAiSdkExecutors({ resolveModel })`. See [Models and providers](models-and-providers.md). The ref `"openai/gpt-5.4-mini"` used on this page is illustrative. Substitute your provider's current models.

## Related

- [Machines as data](machines-as-data.md): the config format, its expressions, and its limits.
- [Testing and verification](verify.md): every check and simulation API in full.
- [examples/json-agent](../examples/json-agent/index.ts): a hand-written config, run.
