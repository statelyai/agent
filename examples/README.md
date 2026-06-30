# Examples

<!-- flat example directories derived from examples/*/metadata.json and examples/index.ts -->

Each example lives in a flat `examples/*` directory with an `index.ts` or `index.mts` entrypoint and a `metadata.json` file describing its origin and comparison purpose.

## Start Here

- Authoring reusable text logic and XState agent machines: [`email-drafter/index.ts`](/Users/davidkpiano/Code/agent/examples/email-drafter/index.ts)
- Running with host actors: [`ai-sdk-host/index.ts`](/Users/davidkpiano/Code/agent/examples/ai-sdk-host/index.ts)
- Host actor guide: [`../docs/host-actors.md`](/Users/davidkpiano/Code/agent/docs/host-actors.md)
- Framework comparison examples: [`langgraph-conditional-routing/index.test.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-conditional-routing/index.test.ts), [`burr-counter/index.test.ts`](/Users/davidkpiano/Code/agent/examples/burr-counter/index.test.ts), [`crewai-content-creator/index.test.ts`](/Users/davidkpiano/Code/agent/examples/crewai-content-creator/index.test.ts), [`dinavinter-test-agent/index.test.ts`](/Users/davidkpiano/Code/agent/examples/dinavinter-test-agent/index.test.ts)

## XState Examples

These use normal XState `setup(...)` plus `createTextLogic(...)` from `@statelyai/agent`. The runtime is flexible: use `createActor(...)` locally, provide different host actors in apps, or persist XState snapshots in a platform adapter.

- [`email-drafter/index.ts`](/Users/davidkpiano/Code/agent/examples/email-drafter/index.ts): typed email workflow with independently testable text logic
- [`game-agent/index.ts`](/Users/davidkpiano/Code/agent/examples/game-agent/index.ts): turn-based game workflow with whitelisted event tools
- [`joke/index.ts`](/Users/davidkpiano/Code/agent/examples/joke/index.ts): minimal streaming text workflow
- [`triage/index.ts`](/Users/davidkpiano/Code/agent/examples/triage/index.ts): structured-output support ticket triage
- [`langgraph-conditional-routing/index.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-conditional-routing/index.ts): LangGraph-style conditional edge
- [`burr-conversational-rag/index.ts`](/Users/davidkpiano/Code/agent/examples/burr-conversational-rag/index.ts): Burr-style RAG with memory in context
- [`crewai-content-creator/index.ts`](/Users/davidkpiano/Code/agent/examples/crewai-content-creator/index.ts): CrewAI Flow-style route-and-generate workflow
- [`email-drafter-smoke/index.mts`](/Users/davidkpiano/Code/agent/examples/email-drafter-smoke/index.mts): deterministic local XState runtime smoke test
- [`ai-sdk-host/index.ts`](/Users/davidkpiano/Code/agent/examples/ai-sdk-host/index.ts): Vercel AI SDK host actors
- [`ai-sdk-game-host/index.ts`](/Users/davidkpiano/Code/agent/examples/ai-sdk-game-host/index.ts): Vercel AI SDK step runner
- [`cloudflare-workers-ai-host/index.ts`](/Users/davidkpiano/Code/agent/examples/cloudflare-workers-ai-host/index.ts): Cloudflare Workers AI step runner
- [`tanstack-ai-host/index.ts`](/Users/davidkpiano/Code/agent/examples/tanstack-ai-host/index.ts): TanStack AI step runner sketch
- [`cloudflare-agent-host/index.ts`](/Users/davidkpiano/Code/agent/examples/cloudflare-agent-host/index.ts): Cloudflare Agents host sketch

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

The parity docs track end-result coverage and remaining gaps. New examples should use `createTextLogic(...)` for reusable LLM work and normal XState `setup({ schemas, actorSources })` for schema-first machine authoring.
