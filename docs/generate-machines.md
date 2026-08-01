---
title: Generating machines with an LLM
description: Have a model author the agent workflow itself, then validate, lint, and simulate the generated config before a single model call runs inside it.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

An agent machine is [data](machines-as-data.md), so a model can write one. The payoff is not that generation is easy: it is that a generated machine can be **checked before it runs**.

- **Bounded.** The config's shape is fixed by a shipped JSON Schema. Expressions are dot paths, not code, so a generated config cannot do anything a hand-authored machine could not.
- **Lintable.** `lintAgentMachine` catches dead decisions, unreachable states, and output-contract gaps statically. Every check applies to config-built machines.
- **Simulatable.** `simulateAgent` plays the machine through with canned responses, keylessly, before it touches a model.

That turns "the model wrote a workflow" into a pipeline with gates, not a leap of faith.

## The loop

```
generate → validate (Ajv) → lower (fromConfig) → lint → simulate → run
```

| Step     | API                                       | Fails on                                                          |
| -------- | ----------------------------------------- | ----------------------------------------------------------------- |
| Generate | your model call                           | nothing (raw text)                                                |
| Validate | Ajv 2020 + `agent-workflow.json`          | malformed config shape                                            |
| Lower    | `setupAgent.fromConfig`                   | unresolved named guards/actions, `onDone` on a decision           |
| Lint     | `lintAgentMachine` / `assertAgentMachine` | undeliverable decisions, unreachable states, missing final output |
| Simulate | `simulateAgent`                           | no path settles; a loop                                           |
| Run      | `runAgent`                                | runtime only                                                      |

Every gate but the last runs with no API key, and each throws a message naming the offending field, state, or path. So a failed gate feeds straight back to the model as a repair prompt instead of surfacing to a user. Cap the repair loop at ~3 attempts: a config that fails three schema-shaped repairs is usually asking for something the data form cannot express, so [author it in TypeScript](machines.md) instead.

## The skill

The full authoring procedure — schema location, the rules a config must follow, a few-shot config, the Ajv adapter, the lint and simulate calls, and the repair loop — ships as an agent skill:

**[`skills/generate-machine/SKILL.md`](https://github.com/statelyai/agent/blob/main/skills/generate-machine/SKILL.md)**

Copy that directory into your coding agent's skills dir (`.claude/skills/` for Claude Code, or wherever your harness loads skills from). The agent then loads it on requests like "author an agent machine for X" and runs the gates itself.

## Limits

Honest constraints on generated machines:

- **Named guards and actions are host-resolved.** A config cannot carry functions. A model can emit `guard: "isReady"`, but the implementation lives in the `guards` passed to `fromConfig(...)`, and an unresolved name is a build-time throw. Either list the names your host implements in the prompt, or forbid them.
- **Ajv validity is not semantic validity.** The schema constrains shape, not meaning: a config can validate and still reference a request that does not exist, or route to a state that solves nothing. That is what the lint and simulate gates are for.
- **A dry run covers one path.** The simulation follows the script you gave it. Use `explorePaths` when the generated branch structure matters.
- **Model refs and tool names are unchecked strings.** They resolve at run time, in the host. Generated machines carry string refs (`"openai/gpt-5.4-mini"`), so pass `createAiSdkExecutors({ resolveModel })` — see [models and providers](models-and-providers.md).

## Where this fits

- [Machines as data](machines-as-data.md): the config format, its expressions, and its limits.
- [Verify](verify.md): every check and simulation API in full.
- [examples/json-agent](../examples/json-agent/index.ts): a hand-written config, run.
