# Examples

<!-- flat example directories derived from examples/*/metadata.json and examples/index.ts -->

Each example lives in a flat `examples/*` directory with an `index.ts` or `index.mts` entrypoint and a `metadata.json` file describing its origin and comparison purpose.

## Start Here

- Decisions — the model choosing exactly one legal machine event: [`twenty-questions/index.ts`](/Users/davidkpiano/Code/agent/examples/twenty-questions/index.ts)
- Minimal streaming text workflow: [`joke/index.ts`](/Users/davidkpiano/Code/agent/examples/joke/index.ts)
- Authoring reusable requests, parts-based messages, and schema-typed state meta: [`email-drafter/index.ts`](/Users/davidkpiano/Code/agent/examples/email-drafter/index.ts)
- Human-in-the-loop, the idle-first way: [`langgraph-human-in-the-loop/index.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-human-in-the-loop/index.ts)
- Running with host actors: [`ai-sdk-host/index.ts`](/Users/davidkpiano/Code/agent/examples/ai-sdk-host/index.ts)
- Machines as data — a full workflow (decision, text request, idle human step) authored as a real `.json` file: [`json-agent/index.ts`](/Users/davidkpiano/Code/agent/examples/json-agent/index.ts)
- Host actor guide: [`../docs/host-actors.md`](/Users/davidkpiano/Code/agent/docs/host-actors.md)
- Framework comparison examples: [`langgraph-conditional-routing/index.test.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-conditional-routing/index.test.ts), [`burr-counter/index.test.ts`](/Users/davidkpiano/Code/agent/examples/burr-counter/index.test.ts), [`crewai-content-creator/index.test.ts`](/Users/davidkpiano/Code/agent/examples/crewai-content-creator/index.test.ts), [`dinavinter-test-agent/index.test.ts`](/Users/davidkpiano/Code/agent/examples/dinavinter-test-agent/index.test.ts)

## XState Examples

These use `setupAgent(...)` (or plain XState `setup(...)` plus `createTextLogic(...)`/`createDecisionLogic(...)`) from `@statelyai/agent`. The runtime is flexible: use `runAgent(...)`/`createActor(...)` locally, provide different host actors in apps, or persist XState snapshots in a platform adapter.

- [`twenty-questions/index.ts`](/Users/davidkpiano/Code/agent/examples/twenty-questions/index.ts): decision loop with guard-enforced legality and idle-first human-in-the-loop resume
- [`email-drafter/index.ts`](/Users/davidkpiano/Code/agent/examples/email-drafter/index.ts): typed email workflow with independently testable requests
- [`game-agent/index.ts`](/Users/davidkpiano/Code/agent/examples/game-agent/index.ts): turn-based game workflow with `allowedEvents` narrowed as a function of input
- [`joke/index.ts`](/Users/davidkpiano/Code/agent/examples/joke/index.ts): minimal streaming text workflow
- [`triage/index.ts`](/Users/davidkpiano/Code/agent/examples/triage/index.ts): structured-output support ticket triage
- [`json-agent/index.ts`](/Users/davidkpiano/Code/agent/examples/json-agent/index.ts): `setupAgent.fromConfig(...)` lowering a support-ticket workflow authored as a real `.json` file (decision, text request, idle human approval step)
- [`langgraph-conditional-routing/index.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-conditional-routing/index.ts): LangGraph-style conditional edge
- [`burr-conversational-rag/index.ts`](/Users/davidkpiano/Code/agent/examples/burr-conversational-rag/index.ts): Burr-style RAG with memory in context
- [`crewai-content-creator/index.ts`](/Users/davidkpiano/Code/agent/examples/crewai-content-creator/index.ts): CrewAI Flow-style route-and-generate workflow
- [`email-drafter-smoke/index.mts`](/Users/davidkpiano/Code/agent/examples/email-drafter-smoke/index.mts): deterministic local XState runtime smoke test
- [`ai-sdk-host/index.ts`](/Users/davidkpiano/Code/agent/examples/ai-sdk-host/index.ts): Vercel AI SDK host actors
- [`ai-sdk-sub-agents/index.ts`](/Users/davidkpiano/Code/agent/examples/ai-sdk-sub-agents/index.ts): Vercel AI SDK ToolLoopAgent workers exposed as host-owned tools
- [`ai-sdk-marketing-chain/index.ts`](/Users/davidkpiano/Code/agent/examples/ai-sdk-marketing-chain/index.ts): Vercel AI SDK sequential chain as an explicit XState machine
- [`ai-sdk-routing/index.ts`](/Users/davidkpiano/Code/agent/examples/ai-sdk-routing/index.ts): Vercel AI SDK routing as an explicit XState machine
- [`ai-sdk-parallel-review/index.ts`](/Users/davidkpiano/Code/agent/examples/ai-sdk-parallel-review/index.ts): Vercel AI SDK parallel review as an explicit XState machine
- [`ai-sdk-orchestrator-worker/index.ts`](/Users/davidkpiano/Code/agent/examples/ai-sdk-orchestrator-worker/index.ts): Vercel AI SDK orchestrator-worker as an explicit XState machine
- [`ai-sdk-evaluator-optimizer/index.ts`](/Users/davidkpiano/Code/agent/examples/ai-sdk-evaluator-optimizer/index.ts): Vercel AI SDK evaluator-optimizer as an explicit XState machine
- [`debate-sub-agents/index.ts`](/Users/davidkpiano/Code/agent/examples/debate-sub-agents/index.ts): facilitator schedules two event-based debater sub-agents
- [`ai-sdk-game-host/index.ts`](/Users/davidkpiano/Code/agent/examples/ai-sdk-game-host/index.ts): Vercel AI SDK step runner
- [`cloudflare-workers-ai-host/index.ts`](/Users/davidkpiano/Code/agent/examples/cloudflare-workers-ai-host/index.ts): Cloudflare Workers AI step runner
- [`tanstack-ai-host/index.ts`](/Users/davidkpiano/Code/agent/examples/tanstack-ai-host/index.ts): TanStack AI step runner sketch
- [`cloudflare-agent-host/index.ts`](/Users/davidkpiano/Code/agent/examples/cloudflare-agent-host/index.ts): Cloudflare Agents host sketch
- [`xstate-sub-agents/index.ts`](/Users/davidkpiano/Code/agent/examples/xstate-sub-agents/index.ts): multi-step agent machines invoking other agent machines as XState child actors

## Comparison Examples

LangGraph:

- [`langgraph-conditional-routing/index.test.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-conditional-routing/index.test.ts)
- [`langgraph-human-in-the-loop/index.test.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-human-in-the-loop/index.test.ts)
- [`langgraph-plan-and-execute/index.test.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-plan-and-execute/index.test.ts)
- [`langgraph-tool-calling-progress/index.test.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-tool-calling-progress/index.test.ts)
- [`langgraph-snapshot-persistence/index.test.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-snapshot-persistence/index.test.ts)
- [`langgraph-subflows/index.test.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-subflows/index.test.ts)
- [`langgraph-supervisor-handoff/index.test.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-supervisor-handoff/index.test.ts)
- [`langgraph-map-reduce/index.test.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-map-reduce/index.test.ts)
- [`langgraph-rag/index.test.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-rag/index.test.ts)
- [`langgraph-reflection-loop/index.test.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-reflection-loop/index.test.ts)
- [`langgraph-rewoo/index.test.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-rewoo/index.test.ts)
- [`langgraph-sql-agent/index.test.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-sql-agent/index.test.ts)
- [`langgraph-persistent-multi-agent-network/index.test.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-persistent-multi-agent-network/index.test.ts)
- [`langgraph-streaming-side-channel/index.test.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-streaming-side-channel/index.test.ts)

Burr:

- [`burr-counter/index.test.ts`](/Users/davidkpiano/Code/agent/examples/burr-counter/index.test.ts)
- [`burr-conversational-rag/index.test.ts`](/Users/davidkpiano/Code/agent/examples/burr-conversational-rag/index.test.ts)
- [`burr-streaming-overview/index.test.ts`](/Users/davidkpiano/Code/agent/examples/burr-streaming-overview/index.test.ts)
- [`burr-tool-calling/index.test.ts`](/Users/davidkpiano/Code/agent/examples/burr-tool-calling/index.test.ts)
- [`burr-typed-state/index.test.ts`](/Users/davidkpiano/Code/agent/examples/burr-typed-state/index.test.ts)
- [`burr-multi-agent-collaboration/index.test.ts`](/Users/davidkpiano/Code/agent/examples/burr-multi-agent-collaboration/index.test.ts)

CrewAI Flow:

- [`crewai-content-creator/index.test.ts`](/Users/davidkpiano/Code/agent/examples/crewai-content-creator/index.test.ts)
- [`crewai-write-a-book/index.test.ts`](/Users/davidkpiano/Code/agent/examples/crewai-write-a-book/index.test.ts)

dinavinter/agents:

- [`dinavinter-test-agent/index.test.ts`](/Users/davidkpiano/Code/agent/examples/dinavinter-test-agent/index.test.ts)
- [`dinavinter-screen-set-builder/index.test.ts`](/Users/davidkpiano/Code/agent/examples/dinavinter-screen-set-builder/index.test.ts)
- [`dinavinter-parallel-agent/index.test.ts`](/Users/davidkpiano/Code/agent/examples/dinavinter-parallel-agent/index.test.ts)

## Parity Tracking

- [`../docs/langgraph-parity.md`](/Users/davidkpiano/Code/agent/docs/langgraph-parity.md)
- [`../docs/langgraph-gaps.md`](/Users/davidkpiano/Code/agent/docs/langgraph-gaps.md)
- [`../docs/crewai-parity.md`](/Users/davidkpiano/Code/agent/docs/crewai-parity.md)
- [`../docs/burr-parity.md`](/Users/davidkpiano/Code/agent/docs/burr-parity.md)

The parity docs track end-result coverage and remaining gaps, honestly — "possible but manual" and "not yet" are used where that's the true state, not "Covered". New examples should use `createTextLogic(...)`/`createDecisionLogic(...)` for reusable LLM work and `setupAgent({ schemas, actors, requests })` for schema-first machine authoring. Decisions are authored inline in states via `agent.decide` (state-local), or with `createDecisionLogic` under `actors:` when reusable — there is no `decisions:` key on `setupAgent`.
