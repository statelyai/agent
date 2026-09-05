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
| `runAgentLoop`                              | Drive repeated idle/resume turns                             |
| `runAgentStream`                            | Observe requests, chunks, transitions, emissions, and settle |
| `provideExecutors`                          | Bind executors for an application-owned XState actor         |
| `createScriptedExecutors`                   | Deterministic named request scripts                          |
| `getInteraction` / `eventFromInteraction`   | Render and validate human interactions                       |
| `isAgentIdle`                               | Default composable idle-state predicate                      |
| `lintAgentMachine`                          | Agent-specific diagnostics                                   |
| `ContextOf` / `EventOf` / other `*Of` types | Extract setup and machine types                              |

The optional `@statelyai/agent/ai-sdk` entry provides `defineModels` and AI SDK executors. Core has no runtime dependency on the AI SDK.
