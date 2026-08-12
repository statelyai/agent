---
title: Generating machines with an LLM
description: Have a model author the agent workflow itself, then validate, lint, and simulate the generated config before a single model call runs inside it.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

This page covers having a model author an agent machine config, then validating, linting, and simulating that config before it runs.

An agent machine is [data](machines-as-data.md), so a model can write one. A generated machine can be checked before it runs, for three reasons.

- The config's shape is fixed by a JSON Schema that ships with the package. Expressions are dot paths, not code, so a generated config cannot do anything a hand-authored machine could not do.
- `validateAgentConfig` checks the config against that schema and returns diagnostics. It is exported from `@statelyai/agent/validate`, which uses `ajv` as an optional peer dependency, so install `ajv` to use it.
- `lintAgentMachine` statically catches dead decisions, unreachable states, and output-contract gaps. Every check applies to machines built from a config.
- `simulateAgent` plays the machine through with canned responses and no API key, before it calls a model.

## The loop

```
generate → validate (validateAgentConfig) → lower (fromConfig) → lint → simulate → run
```

<!-- viz: generation pipeline: generate -> validate (validateAgentConfig) -> lower (fromConfig) -> lint -> simulate -> run, with each failing gate feeding back into generate as a repair prompt, capped at 3 attempts -->


| Step     | API                                       | Fails on                                                          |
| -------- | ----------------------------------------- | ----------------------------------------------------------------- |
| Generate | your model call                           | nothing; the model returns unvalidated text                       |
| Validate | `validateAgentConfig`                     | malformed config shape                                            |
| Lower    | `setupAgent.fromConfig`                   | unresolved named guards/actions, `onDone` on a decision           |
| Lint     | `lintAgentMachine(machine, { throw: true })` | undeliverable decisions, unreachable states, missing final output |
| Simulate | `simulateAgent`                           | the scripted path never settles, such as a machine that loops     |
| Run      | `runAgent`                                | runtime only                                                      |

Each gate runs on the config the model returned, in order:

```ts no-check
import { lintAgentMachine, setupAgent, simulateAgent } from "@statelyai/agent";
import { validateAgentConfig } from "@statelyai/agent/validate";

// 1. Validate the config shape against the JSON Schema.
const { valid, errors } = validateAgentConfig(config);
if (!valid) {
  // Feed these back to the model as a repair prompt.
  throw new Error(errors.map((e) => `${e.path}: ${e.message}`).join("\n"));
}

// 2. Lower the config into a machine. Throws on unresolved names and bad targets.
const { machine } = setupAgent.fromConfig(config, { compileSchema });

// 3. Lint the machine. `throw: true` raises on the first error-severity finding.
lintAgentMachine(machine, { throw: true });

// 4. Simulate a playthrough with no API key.
const { status } = await simulateAgent(machine, {
  input: { question: "refund?" },
  script: { decisions: { "agent.decide": [{ type: "RESOLVE" }] } },
});
if (status !== "done") {
  throw new Error(`Generated machine settled as '${status}'`);
}
```

`compileSchema` is the JSON Schema compiler `fromConfig` uses for the config's schemas. Build it from `ajv`. See [Machines as data](machines-as-data.md).

The gates behave as follows.

- `validateAgentConfig(config)` returns `{ valid, errors }`. Each error is `{ severity, path, message, keyword }`, where `path` is a JSON Pointer into the config. It uses Ajv's 2020 build, which the `agent-workflow.json` dialect requires.
- Validation checks shape only. `fromConfig` is what checks that named guards, actions, and actors are implemented.
- Every gate except `run` works with no API key.
- Each gate throws a message naming the offending field, state, or path. A failed gate can therefore be fed back to the model as a repair prompt instead of surfacing to a user.
- Cap the repair loop at about 3 attempts. A config that fails three schema-shaped repairs usually asks for something the data form cannot express. In that case, [author it in TypeScript](machines.md) instead.

## The skill

The full authoring procedure ships as an agent skill. It covers the schema location, the rules a config must follow, a few-shot config, the Ajv adapter, the lint and simulate calls, and the repair loop.

**[`skills/generate-machine/SKILL.md`](https://github.com/statelyai/agent/blob/main/skills/generate-machine/SKILL.md)**

Copy that directory into your coding agent's skills directory. For Claude Code this is `.claude/skills/`. Other harnesses use their own location. The agent then loads the skill on requests such as "author an agent machine for X" and runs the gates itself.

## Limits

Generated machines have these constraints.

- Named guards and actions are resolved by the host. A config cannot carry functions. A model can emit `guard: "isReady"`, but the implementation lives in the `guards` option passed to `fromConfig(...)`, and an unresolved name throws at build time. List the names your host implements in the prompt, or forbid named references entirely.
- Schema validity is not semantic validity. The schema constrains shape, not meaning. A config can validate and still reference a request that does not exist, or route to a state that does not make progress. The lint and simulate gates cover those cases.
- A dry run covers one path. The simulation follows the script you gave it. Use `explorePaths` when the generated branch structure matters.
- Model refs and tool names are unchecked strings. They resolve at run time, in the host. Generated machines carry string refs, so pass `createAiSdkExecutors({ resolveModel })`. See [Models and providers](models-and-providers.md). The ref `"openai/gpt-5.4-mini"` used on this page is illustrative. Substitute your provider's current models.

## Related

- [Machines as data](machines-as-data.md): the config format, its expressions, and its limits.
- [Testing and verification](verify.md): every check and simulation API in full.
- [examples/json-agent](../examples/json-agent/index.ts): a hand-written config, run.
