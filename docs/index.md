# Stately Agent

Stately Agent is XState plus typed model requests, decisions, and host executors. The state machine remains the single portable agent-logic artifact.

## Mental model

- XState owns states, events, actors, snapshots, persistence semantics, inspection, timers, parallelism, and durable execution.
- Stately Agent owns model request logic, decision constraints, executor binding, interactions, streaming, eval helpers, and Agent-specific lint.
- The host framework owns storage, retries, queues, interruption recovery, and provider SDK behavior.

## Start here

- Greenfield, a new agent: [Quickstart](quickstart.md), then [Thinking in state machines](thinking-in-state-machines.md) or a copied [agent pattern](patterns.md).
- Brownfield, an existing agent loop: [Migrating from a loop](from-a-loop.md), or the shipped `loop-to-machine` skill in `node_modules/@statelyai/agent/skills/`.
- Brownfield, an existing async workflow: [Strangler-fig retrofit](strangler-fig.md). Wrap it unchanged with `wrapWorkflow`, then move one phase at a time into states, checked with `checkParity`.
- [Choosing a run mode](choosing-a-run-mode.md)
- [Advanced: bare XState actors and hand-written executors](advanced.md)

## Core APIs

| API                                         | Purpose                                                                    |
| ------------------------------------------- | -------------------------------------------------------------------------- |
| `runAgent`                                  | Run a machine to done or idle; the default entry point                     |
| `setupAgent`                                | Schema-first XState setup with Agent request actors                        |
| `createAgentRuntime`                        | Advanced, own the loop: bind executors, expose one durable transition loop |
| `runToQuiescence`                           | Advanced, own the loop: drive a runtime to done, idle, or error            |
| `getInteraction` / `eventFromInteraction`   | Render and validate human interactions                                     |
| `decideNext`                                | Ask a model for one event a plain XState machine accepts                   |
| `describeMachine`                           | Render a machine as plain text for a model                                 |
| `wrapWorkflow`                              | Wrap an existing async workflow, unchanged, as a machine                   |
| `isAgentIdle`                               | Distinguish a human wait from a stuck settled machine                      |
| `ContextOf` / `EventOf` / other `*Of` types | Extract setup and machine types                                            |

## Entry points

| Entry                          | Purpose                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| `@statelyai/agent`             | Authoring, running, human interaction, and the executor contract                           |
| `@statelyai/agent/testing`     | `lintAgentMachine`, `simulateAgent`, `canReach`, `checkParity`, trajectories, seams        |
| `@statelyai/agent/log`         | The event log: `replay`, `forkEventLog`, `getDecisionAttempts`, hand-built entries, stores |
| `@statelyai/agent/ai-sdk`      | `createAiSdkExecutors`: the Vercel AI SDK adapter, for language and decision models        |
| `@statelyai/agent/openai`      | Executors over the raw `openai` package                                                    |
| `@statelyai/agent/tanstack-ai` | `createTanStackAiExecutors`, the TanStack AI adapter                                       |
| `@statelyai/agent/machines`    | Preset machines: tool loop, sequential, parallel, router, supervisor, handoff              |
| `@statelyai/agent/otel`        | OpenTelemetry trace handler                                                                |
| `@statelyai/agent/validate`    | JSON workflow config validation and `verifyAgentConfig` pre-run gates                      |

Core has no runtime dependency on the AI SDK.
