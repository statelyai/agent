# Stately Agent

Stately Agent is XState plus typed model requests, decisions, and host executors. The state machine remains the single portable agent-logic artifact.

## Mental model

- XState owns states, events, actors, snapshots, persistence semantics, inspection, timers, parallelism, and durable execution.
- Stately Agent owns model request logic, decision constraints, executor binding, interactions, streaming, eval helpers, and Agent-specific lint.
- The host framework owns storage, retries, queues, interruption recovery, and provider SDK behavior.

## Start here

- [Quickstart](quickstart.md)
- [Thinking in state machines](thinking-in-state-machines.md)
- [Migrating from a loop](from-a-loop.md)
- [Choosing a run mode](choosing-a-run-mode.md)

## Core APIs

| API                                         | Purpose                                                      |
| ------------------------------------------- | ------------------------------------------------------------ |
| `setupAgent`                                | Schema-first XState setup with Agent request actors          |
| `runAgent`                                  | Run one in-process leg to done, idle, or error               |
| `runAgentStream`                            | Observe requests, chunks, transitions, emissions, and settle |
| `provideExecutors`                          | Bind executors for an application-owned XState actor         |
| `initialAgentStep` / `transitionAgentStep`  | The pure step API: `(state, event) => (state, requests)`     |
| `getInteraction` / `eventFromInteraction`   | Render and validate human interactions                       |
| `isAgentIdle`                               | Default composable idle-state predicate                      |
| `ContextOf` / `EventOf` / other `*Of` types | Extract setup and machine types                              |

## Entry points

| Entry                        | Purpose                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------ |
| `@statelyai/agent`           | Authoring, running, human interaction, and the executor contract               |
| `@statelyai/agent/testing`   | `lintAgentMachine`, `simulateAgent`, `canReach`, `createScriptedExecutors`, trajectories, seams |
| `@statelyai/agent/log`       | The event log: `replay`, `forkEventLog`, hand-built entries, stores            |
| `@statelyai/agent/ai-sdk`    | `defineModels` and AI SDK executors                                            |
| `@statelyai/agent/openai`    | Executors over the raw `openai` package                                        |
| `@statelyai/agent/machines`  | Preset machines: tool loop, sequential, parallel, router, supervisor, handoff  |
| `@statelyai/agent/otel`      | OpenTelemetry trace handler                                                    |
| `@statelyai/agent/validate`  | JSON workflow config validation                                                |

Core has no runtime dependency on the AI SDK.
