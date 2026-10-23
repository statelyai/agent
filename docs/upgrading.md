---
title: Upgrading between alphas
description: The breaking changes you are most likely to hit when you move an app from an earlier 2.0 alpha to the current one, and where to find the rest.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

This page lists the breaking changes an app on an earlier 2.0 alpha is most likely to hit. Every release's full notes are in `CHANGELOG.md`, which ships in the package: `node_modules/@statelyai/agent/CHANGELOG.md`.

## Peer versions

- **XState:** exactly the version in the package's `peerDependencies` (`6.0.0-alpha.69` today). Upgrade it in the same change as the agent package.
- **AI SDK:** `ai` 7.0.128 or newer for `@statelyai/agent/ai-sdk`, which imports `experimental_decide`. An older `ai` fails at import time with `does not provide an export named 'experimental_decide'`.

## Removed and moved APIs

| Was                                                                                                           | Now                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `defineModels({ ... })`                                                                                       | A plain `models` map, passed to `setupAgent({ models })` and to `createAiSdkExecutors({ models })`. Pass `executors` to `runAgent` explicitly.                     |
| `createScriptedExecutors`                                                                                     | Removed; the package ships no model mock. Write plain executors that return `{ result }`, or use the AI SDK's `MockLanguageModelV3` behind `createAiSdkExecutors`. |
| `assertAgentMachine`, `lintAgentMachine`, `simulateAgent`, `explorePaths`, `canReach` from `@statelyai/agent` | The same names from `@statelyai/agent/testing`. `assertAgentMachine(machine)` is also `lintAgentMachine(machine, { throw: true })`.                                |
| `replay`, `initEntry`, `createReplayEntry`, `getUsageFromEvents`, the stores from `@statelyai/agent`          | The same names from `@statelyai/agent/log`.                                                                                                                        |
| `setupAgent({ isIdle })`, `idleTags`                                                                          | Removed. A run settles `idle` when the machine waits on an event; `isAgentIdle(snapshot)` tells a human wait from a stuck machine.                                 |

## Changed shapes

- **Text request output.** A request invoke's `onDone` output is `{ result, messages }`: read `output.result.field`, not `output.field`. Executors return `{ result, messages?, usage? }`, not `{ output }`.
- **Schemas.** Every schema must be a [Standard Schema](https://standardschema.dev). `setupAgent` throws `invalid-schema` for one that is not, such as a zod 3.23 schema.
- **Requests.** A `requests` entry needs a `prompt` or `messages`. `setupAgent` throws `invalid-request` for one with neither, even when the executor builds its own model call.

## Checking an upgrade

- Run the type checker first: most of the changes above are type errors.
- Search `CHANGELOG.md` between your old version's heading and the new one for **Breaking** and **Removed**.
