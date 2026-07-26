---
title: Scope and ecosystem boundaries
description: What Stately Agent owns, what the host owns, and where specialized libraries fit.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

`@statelyai/agent` is a portable control-flow tool, not an agent framework. It owns the executable machine: states, legal transitions, typed requests, decisions, composition, suspension, resume, and deterministic testing. The host owns every external capability.

That boundary is deliberate. A machine should run unchanged with a different model SDK, search provider, memory store, sandbox, transport, or evaluation system.

## Ownership boundary

<!-- ownership boundaries derived from src/run-agent.ts, src/steps.ts, src/types.ts, and the host/example adapters -->

| Concern | Owner | Stately Agent integration point |
| --- | --- | --- |
| Workflow states, branching, loops, parallelism, retries, approval gates | Machine | XState machine configuration |
| Model calls and structured output | Host or model SDK | `AgentRequestExecutors` |
| Tools and tool loops | Host or model SDK | request `tools` and `metadata` |
| Search, RAG, crawling, data APIs | Specialized library or service | tool, executor, or `actorSources` implementation |
| Long-term and semantic memory | Database or memory library | load into machine input; expose reads/writes as actors or tools |
| Sandboxes, filesystems, generated artifacts | Sandbox or workspace library | host actors and artifact handles in machine context |
| MCP discovery, auth, sessions, and transport | MCP client or host framework | pass discovered tool descriptors into requests |
| Evaluation datasets, scorers, experiments, and dashboards | Evaluation library | consume `onTrace`, `onResult`, snapshots, and machine outputs |
| Snapshot persistence | Host store | `AgentSnapshotStore` and `persistSnapshot(...)` |
| Queues, schedules, leases, deployment, HTTP/SSE/WebSocket | Runtime or application framework | step API, snapshots, callbacks, emitted events |
| Telemetry export | Observability library | `onTrace` and `inspect` |

The repository includes examples for the orchestration shape, not replacement implementations of those systems. For example, [deep research](../examples/deep-research/index.ts) models planning, concurrent research, reflection, and synthesis; its search implementation still belongs to the host. [Trading team](../examples/trading-team/index.ts) models parallel analysts, debate, risk review, and approval; market feeds and order execution remain external.

## What belongs in core

A feature belongs in core when portable machine intent cannot otherwise be expressed or handed to an arbitrary host without framework-specific glue. Good core candidates improve one of these seams:

- authoring typed, inspectable control flow;
- describing external work without executing it;
- binding that work in any host;
- suspending, persisting, and resuming without changing the machine;
- stepping and replaying deterministically;
- observing a run without coupling it to one telemetry or evaluation vendor.

A feature does not belong in core merely because popular agent applications need it. Search clients, vector stores, browser automation, code sandboxes, skills, prompt registries, eval scorers, and deployment servers are useful precisely because specialized libraries can evolve them independently.

## How to integrate specialized libraries

- Wrap an async capability as an XState actor and provide it through `actorSources`.
- Pass SDK-native tools through a request's `tools` map.
- Put host-only hints in request `metadata`; core preserves it without interpreting it.
- Close over auth, tenant, tracing, and service clients when constructing executors or actors.
- Persist JSON-safe snapshots and external artifact handles, not live clients or binary resources, in machine context.
- Feed traces to an evaluation or observability library through `onTrace`; do not make the machine aware of the destination.

See [Hosts and executors](hosts.md), [Use in any stack](any-stack.md), [The step path](steps.md), and [Multi-agent](multi-agent.md) for the concrete contracts.
