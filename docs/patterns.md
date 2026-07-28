---
title: Agent patterns
description: Common agent patterns (ReAct, reflection, plan-and-execute, RAG, supervisor, and more) as copy-paste XState machines you can run in 60 seconds.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

Every well-known agent pattern is a control-flow shape: a loop, a branch, a fan-out, a handoff. This library makes each one an explicit XState machine you can read, test, and run. Below is a use-case map: pick a pattern, open its example, copy the one file.

## Copy-paste in 60 seconds

Each pattern is a single self-contained `index.ts`: no shared harness, no local imports. To lift one:

1. Copy the one example file into your project as `index.ts`.
2. Install the runtime deps (the provider package major must match your installed `ai` major; this repo is on `ai@6`, so `@ai-sdk/openai@3`, not 4):

   ```sh
   pnpm add @statelyai/agent@2.0.0-alpha.10 ai@^6 zod@^4 xstate@6.0.0-alpha.21 @ai-sdk/openai@^3
   pnpm add -D @types/node typescript tsx
   ```

3. The examples use Node globals (`process`, `console`, `import.meta.url`), so give TypeScript a `tsconfig.json` with `"types": ["node"]`:

   ```json
   {
     "compilerOptions": {
       "module": "nodenext",
       "moduleResolution": "nodenext",
       "target": "es2022",
       "strict": true,
       "types": ["node"]
     }
   }
   ```

4. Run it: `OPENAI_API_KEY=... npx tsx index.ts` (or swap in [any host](hosts.md)).

Peer ranges (from `@statelyai/agent`): `ai@^6.0.67`, `xstate@>=6.0.0-alpha.25 <6.0.0`, `zod@^3.25 || ^4`. `@statelyai/agent` is alpha; pin the exact version.

Every example is dual-mode: run it directly against a real model, or drive it with injected mock executors in a test (no key, no network). Swap the host without touching the machine (see [Use in any stack](any-stack.md)).

## Reasoning and tool loops

| Pattern | What it's for | Example | What the machine buys you |
| --- | --- | --- | --- |
| **ReAct** | Reason then act, one tool call at a time, until an answer | [react-agent](../examples/react-agent/index.ts) | A step-budget guard bounds the loop; the reason-or-act choice is a typed discriminated union, not free text |
| **Tool calling** | Model selects a tool, typed actors execute it | [tool-calling](../examples/tool-calling/index.ts) | Tool dispatch is explicit states; progress reports through transitions |
| **Plan-and-execute** | Plan the steps up front, then execute each | [plan-and-execute](../examples/plan-and-execute/index.ts) | Planner output is structured; execution states iterate the plan (the ReWOO evidence-map idea) |
| **Reflection** | Generate, critique, revise until good enough | [reflection-writer](../examples/reflection-writer/index.ts) | The generate ↔ reflect loop is two states; a guard caps revisions so it can't spin forever |
| **Evaluator-optimizer** | Score an output, optimize, repeat to threshold | [ai-sdk-evaluator-optimizer](../examples/ai-sdk-evaluator-optimizer/index.ts) | The scoring gate is a guard; the loop terminates by construction |

## Retrieval

| Pattern | What it's for | Example | What the machine buys you |
| --- | --- | --- | --- |
| **RAG** | Retrieve, then answer grounded in the results | [rag](../examples/rag/index.ts) | Retrieve and answer are separate typed states; conversational memory lives in context |
| **Corrective RAG (CRAG)** | Grade retrieved docs, re-query or fall back when they're weak | [corrective-rag](../examples/corrective-rag/index.ts) | Self-correction is explicit branch states, not buried conditionals |
| **SQL agent** | Generate a query, run it, synthesize an answer | [sql-agent](../examples/sql-agent/index.ts) | Query generation, DB execution, and synthesis are separate states you can test in isolation |

## Routing and chaining

| Pattern | What it's for | Example | What the machine buys you |
| --- | --- | --- | --- |
| **Routing** | Classify the input, dispatch to a specialized path | [ai-sdk-routing](../examples/ai-sdk-routing/index.ts) | The route is a decision over legal events; each branch is its own state |
| **Prompt chaining** | Run steps in a fixed sequence | [ai-sdk-marketing-chain](../examples/ai-sdk-marketing-chain/index.ts) | The chain is a linear state sequence; each link is independently typed and inspectable |
| **Triage** | Classify a ticket into structured fields | [triage](../examples/triage/index.ts) | Structured output validated against a schema before it leaves the state |

## Multi-agent

| Pattern | What it's for | Example | What the machine buys you |
| --- | --- | --- | --- |
| **Supervisor** | A router dispatches to one of several specialist workers | [supervisor](../examples/supervisor/index.ts) | The routing request's structured output hands off to a typed worker; the graph is the org chart |
| **Swarm handoff** | Specialists hand the conversation off to each other across turns | [swarm-handoff](../examples/swarm-handoff/index.ts) | Handoffs are transitions between typed child actors, persisted across turns |
| **Orchestrator-worker** | An orchestrator fans work out to workers and gathers results | [ai-sdk-orchestrator-worker](../examples/ai-sdk-orchestrator-worker/index.ts) | Fan-out and join are plain `Promise.all` over host actors; the machine owns the coordination |
| **Fan-out (map-reduce)** | Plan N subtasks at runtime, run them, reduce | [fan-out](../examples/fan-out/index.ts) | Dynamic parallelism from a planner, then a deterministic reduce state |

See [Multi-agent](multi-agent.md) for sub-agents and child actors.

## Control and safety

| Pattern | What it's for | Example | What the machine buys you |
| --- | --- | --- | --- |
| **Human in the loop** | Pause for approval, persist, resume in another process | [human-in-the-loop](../examples/human-in-the-loop/index.ts) | An idle state is a durable pause; the snapshot is plain JSON you store anywhere |
| **Guardrails** | Gate input and output through explicit validation states | [guardrails](../examples/guardrails/index.ts) | Guardrails are gate states with guards, not prompt pleading; an illegal path is unreachable |
| **Context compaction** | Bound the context window by summarizing stale turns | [context-compaction](../examples/context-compaction/index.ts) | A `compacting` state folds old history into a running summary once it passes a threshold |
| **Customer support** | Conditional escalation to a human on sensitive actions | [customer-support](../examples/customer-support/index.ts) | Sensitive actions gate on an interrupt state; the model can't act past the guard |

See [Human in the loop](human-in-the-loop.md) for the idle-first pause and snapshot resume.

## Related

- [Examples](examples.md): the full runnable index, grouped by what each demonstrates.
- [Use in any stack](any-stack.md): take any of these machines from local `runAgent` to your server or edge runtime, unchanged.
- [Migrating from a hand-rolled loop](from-a-loop.md): already have a `while` loop? Convert it step by step.
