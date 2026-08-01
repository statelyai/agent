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
   pnpm add @statelyai/agent@2.0.0-alpha.11 ai@^6 zod@^4 xstate@6.0.0-alpha.25 @ai-sdk/openai@^3
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

## Running them from the repo

Examples live under `examples/`, one flat directory per example with an `index.ts` entrypoint. Clone the repo, install, then run any one directly:

```bash
OPENAI_API_KEY=... npx tsx examples/<name>/index.ts
```

- Every example is dual-mode: run it against a real model as above, or drive it with injected mock executors in a test (no key, no network).
- Most expect `OPENAI_API_KEY`; each file notes what it needs at the top. `anthropic-sdk-host` wants `ANTHROPIC_API_KEY`; the two Cloudflare examples target a Workers runtime, not Node/`tsx`.
- Swap the host without touching the machine (see [Use in any stack](any-stack.md)).
- The exhaustive index, with framework-comparison notes, is [examples/README.md](../examples/README.md).

## Start here

The core ideas: text requests, decisions, messages, and JSON authoring.

- [twenty-questions](../examples/twenty-questions/index.ts): a decision loop where the model picks one legal event (ASK or GUESS) per turn; guard-enforced legality, machine-held score, play-again reset.
- [joke](../examples/joke/index.ts): a minimal streaming text workflow.
- [email-drafter](../examples/email-drafter/agent-logic.ts): reusable text logic, parts-based [messages](messages.md), schema-typed state and transition meta.
- [game-agent](../examples/game-agent/index.ts): `allowedEvents` narrowed as a function of input, gating moves by HP.
- [go-fish](../examples/go-fish/index.ts): hidden-information play with a checking-win → agent → human loop; the model chooses requests, the machine enforces the rules.
- [json-agent](../examples/json-agent/index.ts): a full workflow (decision, text request, idle human step) authored as a real `.json` file. See [Machines as data](machines-as-data.md).
- [described-workflow](../examples/described-workflow/index.ts): a plain XState machine with zero invokes (prompts live in state `description`s and `meta`), run via `runAgent`'s `getRequests` option.

## Reasoning and tool loops

For tool use, start with **Tool calling**: your SDK runs the tool loop inside one request, in one machine state. **ReAct** is the same loop unrolled into explicit states — reach for it when individual turns need gating (approval before a tool, a spend guard, a snapshot mid-loop).

| Pattern | What it's for | Example | What the machine buys you |
| --- | --- | --- | --- |
| **Tool calling** | Model selects and runs tools inside one request; the SDK owns the loop | [tool-calling](../examples/tool-calling/index.ts) | The loop runs in a state you control: what's legal before and after it, `metadata.maxSteps` bounds it, progress reports through transitions |
| **ReAct** | The tool loop unrolled: each reason/act/observe turn is a transition | [react-agent](../examples/react-agent/index.ts) | Every turn is gateable, persistable, and inspectable; a step-budget guard bounds the loop; the reason-or-act choice is a typed discriminated union |
| **Plan-and-execute** | Plan the steps up front, then execute each | [plan-and-execute](../examples/plan-and-execute/index.ts) | Planner output is structured; execution states iterate the plan (the ReWOO evidence-map idea) |
| **Reflection** | Generate, critique, revise until good enough | [reflection-writer](../examples/reflection-writer/index.ts) | The generate ↔ reflect loop is two states; a guard caps revisions so it can't spin forever |
| **Evaluator-optimizer** | Score an output, optimize, repeat to threshold | [ai-sdk-evaluator-optimizer](../examples/ai-sdk-evaluator-optimizer/index.ts) | The scoring gate is a guard; the loop terminates by construction |
| **Self-correcting codegen** | Generate code, run it against tests, reflect and retry | [code-assistant](../examples/code-assistant/index.ts) | Execute/check is a typed sandboxed actor; a `maxAttempts` bound ends in an explicit `failed` outcome |
| **Tree search (LATS)** | Expand candidates, score, search a bounded tree | [lats](../examples/lats/index.ts) | UCB-style selection, expansion, and reflection scoring are separate states under a rollout budget |

## Retrieval

| Pattern | What it's for | Example | What the machine buys you |
| --- | --- | --- | --- |
| **RAG** | Retrieve, then answer grounded in the results | [rag](../examples/rag/index.ts) | Retrieve and answer are separate typed states; conversational memory lives in context |
| **Corrective RAG (CRAG)** | Grade retrieved docs, re-query or fall back when they're weak | [corrective-rag](../examples/corrective-rag/index.ts) | Self-correction is explicit branch states, not buried conditionals |
| **Adaptive RAG** | Route local vs web, grade evidence and the answer | [adaptive-rag](../examples/adaptive-rag/index.ts) | Routing, grading, and a bounded query rewrite are each their own state |
| **Deep research** | Plan N searches, research concurrently, reflect, synthesize | [deep-research](../examples/deep-research/index.ts) | Dynamic researchers spawn per query; coverage reflection gates one optional follow-up |
| **SQL agent** | Generate a query, run it, synthesize an answer | [sql-agent](../examples/sql-agent/index.ts) | Query generation, DB execution, and synthesis are separate states you can test in isolation |

## Routing and chaining

| Pattern | What it's for | Example | What the machine buys you |
| --- | --- | --- | --- |
| **Routing** | Classify the input, dispatch to a specialized path | [ai-sdk-routing](../examples/ai-sdk-routing/index.ts) | The route is a decision over legal events; each branch is its own state |
| **Prompt chaining** | Run steps in a fixed sequence | [ai-sdk-marketing-chain](../examples/ai-sdk-marketing-chain/index.ts) | The chain is a linear state sequence; each link is independently typed and inspectable |
| **Parallel review** | Run independent reviewers at once, then aggregate | [ai-sdk-parallel-review](../examples/ai-sdk-parallel-review/index.ts) | Parallel states fan out; the join is a plain aggregation state |
| **Triage** | Classify a ticket into structured fields | [triage](../examples/triage/index.ts) | Structured output validated against a schema before it leaves the state |

## Multi-agent

| Pattern | What it's for | Example | What the machine buys you |
| --- | --- | --- | --- |
| **Supervisor** | A router dispatches to one of several specialist workers | [supervisor](../examples/supervisor/index.ts) | The routing request's structured output hands off to a typed worker; the graph is the org chart |
| **Swarm handoff** | Specialists hand the conversation off to each other across turns | [swarm-handoff](../examples/swarm-handoff/index.ts) | Handoffs are transitions between typed child actors, persisted across turns |
| **Orchestrator-worker** | An orchestrator fans work out to workers and gathers results | [ai-sdk-orchestrator-worker](../examples/ai-sdk-orchestrator-worker/index.ts) | Fan-out and join are plain `Promise.all` over host actors; the machine owns the coordination |
| **Fan-out (map-reduce)** | Plan N subtasks at runtime, run them, reduce | [fan-out](../examples/fan-out/index.ts) | Dynamic parallelism from a planner, then a deterministic reduce state |
| **Hierarchical teams** | A coordinator invokes child team machines | [hierarchical-teams](../examples/hierarchical-teams/index.ts) | Each team is a nested machine with a typed boundary; the coordinator can force one revision round |
| **Whole-org workflow** | Parallel analysts, debate, proposal, risk review, approval | [trading-team](../examples/trading-team/index.ts) | One composite workflow; the reject-and-revise loop is states, not retries |
| **Sub-agents** | Compose agent machines as child actors or host tools | [subflows](../examples/subflows/index.ts), [ai-sdk-sub-agents](../examples/ai-sdk-sub-agents/index.ts), [debate-sub-agents](../examples/debate-sub-agents/index.ts) | Each child keeps its own executor binding; parents stay typed against results |

See [Multi-agent](multi-agent.md) for sub-agents and child actors.

## Control and safety

| Pattern | What it's for | Example | What the machine buys you |
| --- | --- | --- | --- |
| **Human in the loop** | Pause for approval, persist, resume in another process | [human-in-the-loop](../examples/human-in-the-loop/index.ts) | An idle state is a durable pause; the snapshot is plain JSON you store anywhere |
| **Guardrails** | Gate input and output through explicit validation states | [guardrails](../examples/guardrails/index.ts) | Guardrails are gate states with guards, not prompt pleading; an illegal path is unreachable |
| **Context compaction** | Bound the context window by summarizing stale turns | [context-compaction](../examples/context-compaction/index.ts) | A `compacting` state folds old history into a running summary once it passes a threshold |
| **Customer support** | Conditional escalation to a human on sensitive actions | [customer-support](../examples/customer-support/index.ts) | Sensitive actions gate on an interrupt state; the model can't act past the guard |

Longer pauses and durable threads:

- [long-running-onboarding](../examples/long-running-onboarding/index.ts): a multi-day coordinator with durable typed state, two idle dormancy gates, delegated IT provisioning, JSON snapshot resume.
- [file-snapshot-store](../examples/file-snapshot-store/index.ts): a file-backed snapshot store for durable threads across processes.

See [Human in the loop](human-in-the-loop.md) for the idle-first pause and snapshot resume.

## Hosts and runtimes

The same machines against different SDKs and runtimes. See [Hosts](hosts.md) and [Event log](event-log.md).

- [ai-sdk-host](../examples/ai-sdk-host/index.ts): running with Vercel AI SDK host actors.
- [ai-sdk-game-host](../examples/ai-sdk-game-host/index.ts): a thin-loop Vercel AI SDK runner that appends every model call to the event log.
- [openai-sdk-host](../examples/openai-sdk-host/index.ts): the same executor contract against the raw `openai` package (Chat Completions), no AI SDK in between.
- [anthropic-sdk-host](../examples/anthropic-sdk-host/index.ts): the same contract against the raw `@anthropic-ai/sdk` package (Messages API).
- [cloudflare-workers-ai-host](../examples/cloudflare-workers-ai-host/index.ts): a Workers AI host that persists only the event log and resumes by replay.
- [cloudflare-agent-host](../examples/cloudflare-agent-host/index.ts): a Cloudflare Agents host persisting snapshots in Durable Object state.
- [parallel-streams](../examples/parallel-streams/index.ts): fan-out over parallel worker streams relayed through a side channel.
- [sse-transport](../examples/sse-transport/index.ts): relaying provider stream chunks over an SSE transport.

## Evaluation, migration, observability

- [simulated-user-evaluation](../examples/simulated-user-evaluation/index.ts): a target chatbot and simulated user alternate under a turn bound, then an independent judge scores the transcript.
- [retrofit](../examples/retrofit/index.ts): a tangled hand-rolled agent (`before.ts`) refactored stepwise into a machine, each step shippable, with `simulateAgent` tests pinning before/after behavior. The worked proof for [Migrating from a loop](from-a-loop.md).
- [langsmith-otel](../examples/langsmith-otel/index.ts): the `onTrace` stream mapped to OpenTelemetry spans and exported to LangSmith; prints the trace stream to stdout without keys. See [Observability](observability.md).

## Related

- [examples/README.md](../examples/README.md): the exhaustive example index, including framework-comparison notes.
- [Use in any stack](any-stack.md): take any of these machines from local `runAgent` to your server or edge runtime, unchanged.
- [Migrating from a hand-rolled loop](from-a-loop.md): already have a `while` loop? Convert it step by step.
