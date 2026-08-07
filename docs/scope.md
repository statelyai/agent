---
title: Scope and ecosystem boundaries
description: What Stately Agent owns, what the host owns, and where specialized libraries fit.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

`@statelyai/agent` is a portable control-flow tool, not an agent framework. It owns the executable machine: states, legal transitions, typed requests, decisions, composition, suspension, resume, and deterministic testing. The host owns every external capability.

That boundary is what makes a machine portable. Agent frameworks that bundle a model client, a search client, a memory store, and a server all at once tie your control flow to those choices. Here the machine only ever describes work; the host decides how it happens, so the same machine runs against a different SDK, provider, or database with no edits.

In practice the machine says *what*:

```ts no-check
searching: {
  invoke: { src: "searchWeb", input: ({ context }) => ({ query: context.query }) },
}
```

and the host says *how*, binding `searchWeb` to whichever search client, cache, and auth it uses.

## Ownership boundary

<!-- ownership boundaries derived from src/run-agent.ts, src/steps.ts, src/types.ts, and the host/example adapters -->

| Concern                                                                 | Owner                            | Stately Agent integration point                                 |
| ----------------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------- |
| Workflow states, branching, loops, parallelism, retries, approval gates | Machine                          | XState machine configuration                                    |
| Model calls and structured output                                       | Host or model SDK                | `AgentRequestExecutors`                                         |
| Tools and tool loops                                                    | Host or model SDK                | request `tools` and `metadata`                                  |
| Search, RAG, crawling, data APIs                                        | Specialized library or service   | tool, executor, or `actors` implementation                      |
| Long-term and semantic memory                                           | Database or memory library       | load into machine input; expose reads/writes as actors or tools |
| Sandboxes, filesystems, generated artifacts                             | Sandbox or workspace library     | host actors and artifact handles in machine context             |
| MCP discovery, auth, sessions, and transport                            | MCP client or host framework     | pass discovered tool descriptors into requests                  |
| Evaluation datasets, scorers, experiments, and dashboards               | Evaluation library               | consume `onTrace`, `onResult`, snapshots, and machine outputs   |
| Snapshot persistence                                                    | Host store                       | `AgentSnapshotStore` and `persistSnapshot(...)`                 |
| Queues, schedules, leases, deployment, HTTP/SSE/WebSocket               | Runtime or application framework | step API, snapshots, callbacks, emitted events                  |
| Telemetry export                                                        | Observability library            | `onTrace` and `inspect`                                         |

The repository includes examples for the orchestration shape, not replacement implementations of those systems:

- [Deep research](../examples/deep-research/index.ts) models planning, concurrent research, reflection, and synthesis. Its search implementation still belongs to the host.
- [Trading team](../examples/trading-team/index.ts) models parallel analysts, debate, risk review, and approval. Market feeds and order execution remain external.

## Core criteria

A feature belongs in core when portable machine intent cannot otherwise be expressed or handed to an arbitrary host without framework-specific glue. Good core candidates improve one of these seams:

- authoring typed, inspectable control flow;
- describing external work without executing it;
- binding that work in any host;
- suspending, persisting, and resuming without changing the machine;
- stepping and replaying deterministically;
- observing a run without coupling it to one telemetry or evaluation vendor.

A feature does not belong in core merely because popular agent applications need it. Search clients, vector stores, browser automation, code sandboxes, skills, prompt registries, eval scorers, and deployment servers are useful precisely because specialized libraries can evolve them independently.

## Integration recipes

- Wrap an async capability as an XState actor and provide it through `actors`.
- Pass SDK-native tools through a request's `tools` map.
- Put host-only hints in request `metadata`; core preserves it without interpreting it.
- Close over auth, tenant, tracing, and service clients when constructing executors or actors.
- Persist JSON-safe snapshots and external artifact handles, not live clients or binary resources, in machine context.
- Feed traces to an evaluation or observability library through `onTrace`; do not make the machine aware of the destination.

## Related

- [Hosts and executors](hosts.md): the executor contract the host implements.
- [Use in any stack](any-stack.md): the same machine across local, server, and edge hosts.
- [The step path](steps.md): the per-model-call loop durable hosts own.
- [Multi-agent composition](multi-agent.md): composing machines without an orchestration layer.
- [Post-alpha roadmap](roadmap.md): what is deliberately not shipped yet.
