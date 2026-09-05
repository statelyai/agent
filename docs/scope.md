---
title: Scope and ecosystem boundaries
description: What Stately Agent owns, what the host owns, and where specialized libraries fit.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

This page describes what `@statelyai/agent` implements, what your host implements, and where other libraries fit.

`@statelyai/agent` is a control-flow library, not an agent framework. It owns the executable machine: states, legal transitions, typed requests, decisions, composition, suspension, resume, and deterministic testing. The host owns every external capability.

This boundary is what makes a machine portable. An agent framework that bundles a model client, a search client, a memory store, and a server ties your control flow to those choices. Here, the machine describes work and the host decides how the work happens. The same machine runs against a different SDK, provider, or database without edits.

The machine declares what happens:

<!-- viz: ownership boundary diagram: machine (states, requests, decisions) | executors/actors seam | host capabilities (model SDK, search, memory, sandbox, store, telemetry) -->

```ts no-check
searching: {
  invoke: { src: "searchWeb", input: ({ context }) => ({ query: context.query }) },
}
```

The host decides how it happens, binding `searchWeb` to the search client, cache, and auth it uses.

## Ownership boundary

<!-- ownership boundaries derived from src/run-agent.ts, src/steps.ts, src/types.ts, and the host/example adapters -->

| Concern                                                                 | Owner                            | Stately Agent integration point                      |
| ----------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------- |
| Workflow states, branching, loops, parallelism, retries, approval gates | Machine                          | Machine configuration                                |
| Model calls and structured output                                       | Host or model SDK                | `AgentRequestExecutors`                              |
| Tools and tool loops                                                    | Host or model SDK                | Request `tools` and `metadata`                       |
| Search, RAG, crawling, data APIs                                        | Specialized library or service   | Request `tools`, executors, or `actors`              |
| Long-term and semantic memory                                           | Database or memory library       | Machine `input`, plus `actors` for reads and writes  |
| Sandboxes, filesystems, generated artifacts                             | Sandbox or workspace library     | `actors`, plus artifact handles in machine context   |
| MCP discovery, auth, sessions, and transport                            | MCP client or host framework     | Request `tools`                                      |
| Evaluation datasets, scorers, experiments, and dashboards               | Evaluation library               | `onTrace`, `onResult`, snapshots, and machine output |
| Snapshot persistence                                                    | Host store                       | XState persisted snapshots from `result.persist()`   |
| Queues, schedules, leases, deployment, HTTP/SSE/WebSocket               | Runtime or application framework | XState snapshots, callbacks, and emitted events      |
| Telemetry export                                                        | Observability library            | `onTrace` and `inspect`                              |

The repository examples show the orchestration shape. They are not replacement implementations of the systems listed above.

- [Deep research](https://github.com/statelyai/agent/blob/main/examples/deep-research/index.ts) models planning, concurrent research, reflection, and synthesis. The host still supplies the search implementation.
- [Hierarchical teams](https://github.com/statelyai/agent/blob/main/examples/hierarchical-teams/index.ts) models specialized child agents. External data and side effects remain host-owned.

## Core criteria

The rules for what belongs in core live in [CONTRIBUTING.md](https://github.com/statelyai/agent/blob/main/CONTRIBUTING.md).

## Non-goals

- Visualization tooling. Stately Studio and the VS Code extension handle diagramming and inspection.
- Search clients, vector stores, browser automation, code sandboxes, skills, prompt registries, eval scorers, and deployment servers. These evolve independently as specialized libraries.

## Integration recipes

The seam between tools and actors is fixed. Tools are chosen by the model within one request. Actors are steps the machine orchestrates.

- Wrap an async capability as an XState actor and provide it through `actors`.
- Pass SDK-native tools through a request's `tools` map.
- Put host-only hints in request `metadata`. Core preserves `metadata` without interpreting it.
- Close over auth, tenant, tracing, and service clients when you construct executors or actors.
- Store JSON-safe snapshots and external artifact handles in machine context. Do not store live clients or binary resources there.
- Send traces to an evaluation or observability library through `onTrace`. The machine does not need to know the destination.

## Related

- [Hosts and executors](hosts.md): the executor contract the host implements.
- [Use in any stack](any-stack.md): the same machine across local, server, and edge hosts.
- [The XState transition loop](steps.md): the effect lifecycle custom and durable hosts own.
- [Multi-agent composition](multi-agent.md): composing machines without an orchestration layer.
- [Post-alpha roadmap](roadmap.md): what is deliberately not shipped yet.
