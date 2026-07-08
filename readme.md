# @statelyai/agent

<!--
Tagline options (pick one, delete the rest):
1. "The logic layer for your agents." (current pick: accurate, matches the package description)
2. "Agents you can reason about."
3. "Give your agents a spine."
4. "The decision layer for AI agents."
5. "Typed state machines for AI agents. Any model, any host."
6. "The deterministic core for your agentic shell."
-->

**The deterministic logic layer for your agents.** Author an agent as a typed XState state machine: the machine declares which states exist, which transitions and events are legal right now, and validates every model output against a schema. Your code executes the model calls, with any SDK, on any runtime. The result is a portable blueprint that runs the same under your own loop, inside a workflow engine, or embedded as a single tool call in someone else's harness.

**Alpha.** The API changed completely in this release and is still settling. Expect breaking changes before 2.0 stable. Feedback and issues welcome.

## Install

```sh
pnpm add @statelyai/agent xstate@6.0.0-alpha.17
```

- **Runtime:** Node >= 22.18.
- **Peers:** the XState v6 alpha (`xstate@6.0.0-alpha.x`). `ai` (Vercel AI SDK) is optional, only for the `@statelyai/agent/ai-sdk` adapter.

## Quick start

<!-- guarded-decision + idle-approval quickstart; decision pattern from examples/game-agent, idle/resume from examples/human-in-the-loop -->

A refund agent in one machine: the model decides, a **guard** owns the $100 auto-approval limit (the model cannot approve a $5,000 refund, no matter what it wants), and anything above the limit **pauses for a human** as a plain serializable snapshot.

```ts
import { z } from 'zod';
import { createAgentSchemas, runAgent, sendDecision, setupAgent } from '@statelyai/agent';
import { createAiSdkExecutors } from '@statelyai/agent/ai-sdk';
import { openai } from '@ai-sdk/openai';

const models = { quick: openai('gpt-5.4-mini') } as const;

const agent = setupAgent({
  models,
  schemas: createAgentSchemas({
    context: z.object({ request: z.string(), amount: z.number() }),
    input: z.object({ request: z.string(), amount: z.number() }),
    output: z.object({ refunded: z.boolean() }),
    events: {
      AUTO_APPROVE: z.object({}),
      NEEDS_REVIEW: z.object({ reason: z.string() }),
      APPROVE: z.object({}),
      DENY: z.object({}),
    },
  }),
});

const machine = agent.createMachine({
  context: ({ input }) => input,
  initial: 'deciding',
  states: {
    deciding: {
      invoke: {
        src: 'agent.decide',
        input: ({ context }) => ({
          model: 'quick',
          system: 'Decide whether this refund can be auto-approved.',
          prompt: `${context.request} (amount: $${context.amount})`,
          allowedEvents: ['AUTO_APPROVE', 'NEEDS_REVIEW'] as const, // typo = compile error
        }),
        onDone: sendDecision(),
      },
      on: {
        // The guard owns the limit, not the prompt: AUTO_APPROVE above $100 is
        // rejected and the model is re-asked with typed feedback.
        AUTO_APPROVE: ({ context }) =>
          context.amount <= 100 ? { target: 'refunded' } : undefined,
        NEEDS_REVIEW: { target: 'awaitingHuman' },
      },
    },
    awaitingHuman: {
      // No invoke: runAgent settles { status: 'idle', snapshot } here.
      on: {
        APPROVE: { target: 'refunded' },
        DENY: { target: 'denied' },
      },
    },
    refunded: { type: 'final', output: () => ({ refunded: true }) },
    denied: { type: 'final', output: () => ({ refunded: false }) },
  },
});

const executors = createAiSdkExecutors({ models });

const result = await runAgent(machine, {
  input: { request: 'Refund my duplicate charge', amount: 5000 },
  ...executors,
});

if (result.status === 'idle') {
  // Persist result.snapshot anywhere (it is plain JSON), then, once the
  // human decides, resume in any process:
  const resumed = await runAgent(machine, {
    snapshot: result.snapshot,
    event: { type: 'APPROVE' },
    ...executors,
  });
  if (resumed.status === 'done') console.log(resumed.output); // { refunded: true }
}
```

## Bring your own stack

<!-- executor contract summary, from src/text-logic.ts (AgentRequestExecutors) and the host examples -->

The machine never talks to a model. It emits typed requests; a host resolves them with an executor set of up to three plain functions (`generateText`, `streamText`, `decide`) that return `{ output }`:

- **Vercel AI SDK:** `createAiSdkExecutors({ models })` from `@statelyai/agent/ai-sdk` is the one shipped adapter.
- **Raw SDKs:** the same contract hand-rolled against the `openai` package ([examples/openai-sdk-host](examples/openai-sdk-host)) and `@anthropic-ai/sdk` ([examples/anthropic-sdk-host](examples/anthropic-sdk-host)).
- **Edge/durable runtimes:** inside a Cloudflare Durable Object ([examples/cloudflare-agent-host](examples/cloudflare-agent-host)) and against Workers AI ([examples/cloudflare-workers-ai-host](examples/cloudflare-workers-ai-host)).
- **Anything else:** a raw `fetch` works; the contract is plain objects in, `{ output }` out. See [hosts](https://stately.ai/docs/agents).

Embedding instead of hosting? A run-to-done machine drops into a normal tool call as-is, because `runAgent` is just an awaitable function:

```ts
const refundTool = tool({
  description: 'Process a refund through the approval workflow.',
  inputSchema: z.object({ request: z.string(), amount: z.number() }),
  execute: async (input) => {
    const result = await runAgent(machine, { input, ...executors });
    return result.status === 'done' ? result.output : { pending: true };
  },
});
```

For machines that pause for approval across tool calls, persist the idle snapshot as a handle and resume it from a second tool: [examples/machine-as-tool](examples/machine-as-tool).

## What the machine gives you

<!-- feature tour, one line per doc page in docs/meta.json -->

- **Decisions.** The model picks exactly one currently-legal event; guards reject anything else, with typed validation failures fed back on retry. Illegal choices are impossible, not discouraged by a prompt. See [examples/twenty-questions](examples/twenty-questions).
- **Human-in-the-loop.** No interrupt call to learn: a waiting state is just a state. `runAgent` settles `{ status: 'idle', snapshot }`; persist the JSON snapshot anywhere and resume with an event, in another process, days later. Work done before the pause can never re-run on resume. See [examples/human-in-the-loop](examples/human-in-the-loop).
- **Durable execution.** The step path advances the machine with pure, synchronous transition functions, so hosts like Temporal or Cloudflare Workflows can checkpoint after every model call and replay deterministically. See [examples/ai-sdk-game-host](examples/ai-sdk-game-host).
- **Dynamic fan-out.** Spawn N branches at runtime with per-branch state visible in the snapshot, then reduce. See [examples/fan-out](examples/fan-out).
- **Traceable runs.** `runAgent` can emit one ordered `onTrace` stream for evals, JSONL logs, and telemetry adapters, while `onChunk` handles streaming text and `on` handles typed domain progress from `enq.emit(...)`. See [examples/ai-sdk-evaluator-optimizer](examples/ai-sdk-evaluator-optimizer).
- **Machines as data.** A whole agent as validated JSON, safe to generate, store, or edit visually, run identically to hand-authored TypeScript. See [examples/json-agent](examples/json-agent).

**Full documentation: [stately.ai/docs/agents](https://stately.ai/docs/agents)** · [What's not here yet](docs/roadmap.md)

## Try the examples

<!-- example run convention + starter picks, from examples/README.md -->

Every example runs directly with a real model and ships a keyless mock-driven test:

```sh
OPENAI_API_KEY=... npx tsx examples/twenty-questions/index.ts
```

Good starting points: [twenty-questions](examples/twenty-questions) (decisions and guards in a game loop), [react-agent](examples/react-agent) (the classic tool-calling loop as visible states), [fan-out](examples/fan-out) (dynamic parallel branches), [supervisor](examples/supervisor) (multi-agent routing). The full index lives in [examples/README.md](examples/README.md).

## Prior art

<!-- prior-art comparisons; brief and difference-focused, no dedicated comparison docs -->

- **[XState](https://github.com/statelyai/xstate)** is the foundation, not a comparison: agents here are ordinary XState machines, so everything XState provides (guards, parallel states, actors, snapshots, visualization) applies unchanged.
- **[LangGraph](https://github.com/langchain-ai/langgraphjs)** is a graph runtime with a deep platform (checkpointers, Studio, LangSmith). This library is an authoring layer with no runtime of its own: state merges are explicit assigns instead of channel reducers, pauses are states instead of `interrupt()` calls, and your code makes every model call.
- **[Burr](https://github.com/apache/burr)** shares the explicit-state philosophy in Python, with its own tracking runtime. This library is TypeScript-first and brings XState's statechart semantics (hierarchy, parallelism, guards) instead of a flat action graph.
- **[CrewAI](https://github.com/crewAIInc/crewAI)** and role-based frameworks orchestrate agents that talk to each other; the flow emerges from the crew. Here the flow is declared, and multi-agent shapes (supervisor, handoff, sub-agents) are machines invoking machines.
- **[Vercel AI SDK](https://github.com/vercel/ai)** is an execution layer, not an alternative: the shipped adapter drives it, and its agent loop can run inside a machine state when you want a loop without authoring one.

The common thread: most agent frameworks own the loop and let you configure it. This one lets you own the loop, or hand it to any host, while the machine owns what is allowed to happen.
