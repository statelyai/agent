---
title: Examples
description: A curated index of runnable @statelyai/agent examples, grouped by what they demonstrate.
---

## Running the examples

The examples live in the repo under `examples/`, one flat directory per example with an `index.ts` entrypoint. Clone the repo, install dependencies, and run any example directly with `tsx`:

```bash
node --import tsx examples/<name>/index.ts
```

Most examples that call a real model expect a provider key in the environment, for example `OPENAI_API_KEY`. Each file notes what it needs at the top.

<!-- curated example index derived from examples/README.md and examples/* directories -->

## Start here

These five cover the core ideas: text requests, decisions, messages, and JSON authoring.

- [twenty-questions](../examples/twenty-questions/index.ts): a decision loop where the model picks one legal event (ASK or GUESS) each turn, with guard-enforced legality, machine-held score, play-again reset, and machine-owned user prompts.
- [joke](../examples/joke/index.ts): a minimal streaming text workflow.
- [email-drafter](../examples/email-drafter/index.ts): reusable text logic, parts-based [messages](messages.md), and schema-typed state and transition meta.
- [game-agent](../examples/game-agent/index.ts): `allowedEvents` narrowed as a function of input, gating moves by HP.
- [json-agent](../examples/json-agent/index.ts): a full workflow (decision, text request, idle human step) authored as a real `.json` file and run with `runAgent`. See [Machines as data](machines-as-data.md).

## Human in the loop and persistence

These show the idle-first pause for human input and resuming a run by snapshot. See [Human in the loop](human-in-the-loop.md).

- [langgraph-human-in-the-loop](../examples/langgraph-human-in-the-loop/index.ts): a machine that settles idle to wait for a human, then resumes with the human's event.
- [langgraph-snapshot-persistence](../examples/langgraph-snapshot-persistence/index.ts): persisting a snapshot between iterations and resuming in a later process.

## Host adapters and the step path

These implement the executor contract against different SDKs and runtimes, and use the lower-level step path for durable checkpointing. See [Hosts](hosts.md) and [Steps](steps.md).

- [ai-sdk-host](../examples/ai-sdk-host/index.ts): running with Vercel AI SDK host actors.
- [ai-sdk-game-host](../examples/ai-sdk-game-host/index.ts): a Vercel AI SDK step runner that checkpoints every model call.
- [openai-sdk-host](../examples/openai-sdk-host/index.ts): the same executor contract against the raw `openai` package (Chat Completions), no Vercel AI SDK in between.
- [anthropic-sdk-host](../examples/anthropic-sdk-host/index.ts): the same contract against the raw `@anthropic-ai/sdk` package (Messages API).
- [cloudflare-workers-ai-host](../examples/cloudflare-workers-ai-host/index.ts): a step runner against Cloudflare Workers AI's binding.
- [cloudflare-agent-host](../examples/cloudflare-agent-host/index.ts): a Cloudflare Agents host persisting snapshots in Durable Object state.
- [tanstack-ai-host](../examples/tanstack-ai-host/index.ts): a step-loop sketch against TanStack AI's chat interface.

## Sub-agents and composition

These compose agent machines as sub-agents or child actors. See [Multi-agent](multi-agent.md).

- [xstate-sub-agents](../examples/xstate-sub-agents/index.ts): agent machines invoking other agent machines as XState child actors.
- [ai-sdk-sub-agents](../examples/ai-sdk-sub-agents/index.ts): Vercel AI SDK ToolLoopAgent workers exposed as host-owned tools.
- [debate-sub-agents](../examples/debate-sub-agents/index.ts): a facilitator scheduling two event-based debater sub-agents.
- [langgraph-subflows](../examples/langgraph-subflows/index.ts): a nested child machine keeping its own executor binding.
- [ai-sdk-marketing-chain](../examples/ai-sdk-marketing-chain/index.ts): a sequential chain expressed as an explicit XState machine.
- [ai-sdk-routing](../examples/ai-sdk-routing/index.ts): routing expressed as an explicit XState machine.
- [ai-sdk-parallel-review](../examples/ai-sdk-parallel-review/index.ts): parallel review expressed as an explicit XState machine.
- [ai-sdk-orchestrator-worker](../examples/ai-sdk-orchestrator-worker/index.ts): an orchestrator-worker pattern as an explicit XState machine.
- [ai-sdk-evaluator-optimizer](../examples/ai-sdk-evaluator-optimizer/index.ts): an evaluator-optimizer loop as an explicit XState machine.

> **Note:** The full example index, including framework-comparison examples for LangGraph, Burr, and CrewAI Flow, lives in [examples/README.md](../examples/README.md).
