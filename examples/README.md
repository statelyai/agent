# Examples

<!-- flat example directories derived from examples/*/metadata.json and examples/index.ts -->

Each example lives in a flat `examples/*` directory with an `index.ts` or `index.mts` entrypoint and a `metadata.json` file describing its origin and comparison purpose.

Every example is dual-mode: run it directly against a real model with `OPENAI_API_KEY=... npx tsx examples/<name>/index.ts`, while its tests use injected mocks.

## Start Here

- Decisions — the model choosing exactly one legal machine event: [`twenty-questions/index.ts`](/Users/davidkpiano/Code/agent/examples/twenty-questions/index.ts)
- Minimal streaming text workflow: [`joke/index.ts`](/Users/davidkpiano/Code/agent/examples/joke/index.ts)
- Authoring reusable requests, parts-based messages, and schema-typed state meta: [`email-drafter/index.ts`](/Users/davidkpiano/Code/agent/examples/email-drafter/index.ts)
- Human-in-the-loop, the idle-first way: [`human-in-the-loop/index.ts`](/Users/davidkpiano/Code/agent/examples/human-in-the-loop/index.ts)
- Long-running onboarding with durable idle gates: [`long-running-onboarding/index.ts`](/Users/davidkpiano/Code/agent/examples/long-running-onboarding/index.ts)
- Running with host actors: [`ai-sdk-host/index.ts`](/Users/davidkpiano/Code/agent/examples/ai-sdk-host/index.ts)
- Machines as data — a full workflow (decision, text request, idle human step) authored as a real `.json` file: [`json-agent/index.ts`](/Users/davidkpiano/Code/agent/examples/json-agent/index.ts)
- Host actor guide: [`../docs/host-actors.md`](/Users/davidkpiano/Code/agent/docs/host-actors.md)
- Framework comparison examples: [`supervisor/index.test.ts`](/Users/davidkpiano/Code/agent/examples/supervisor/index.test.ts), [`plan-and-execute/index.test.ts`](/Users/davidkpiano/Code/agent/examples/plan-and-execute/index.test.ts), [`rag/index.test.ts`](/Users/davidkpiano/Code/agent/examples/rag/index.test.ts), [`tool-calling/index.test.ts`](/Users/davidkpiano/Code/agent/examples/tool-calling/index.test.ts)

## XState Examples

These use `setupAgent(...)` (or plain XState `setup(...)` plus `createTextLogic(...)`) from `@statelyai/agent`. The runtime is flexible: use `runAgent(...)`/`createActor(...)` locally, provide different host actors in apps, or persist XState snapshots in a platform adapter.

- [`twenty-questions/index.ts`](/Users/davidkpiano/Code/agent/examples/twenty-questions/index.ts): decision loop with machine-held context, typed model aliases, final-turn guess enforcement, scoring, play-again reset, and machine-owned user prompts
- [`email-drafter/index.ts`](/Users/davidkpiano/Code/agent/examples/email-drafter/index.ts): typed email workflow with independently testable requests
- [`email-drafter-inspector/index.ts`](/Users/davidkpiano/Code/agent/examples/email-drafter-inspector/index.ts): the email-drafter machine run as one live `createActor` session wired to `createWebSocketInspector`, so the whole flow is visible in the Stately Inspector (works without an API key via heuristic fallbacks)
- [`game-agent/index.ts`](/Users/davidkpiano/Code/agent/examples/game-agent/index.ts): turn-based game workflow with `allowedEvents` narrowed as a function of input
- [`joke/index.ts`](/Users/davidkpiano/Code/agent/examples/joke/index.ts): minimal streaming text workflow
- [`triage/index.ts`](/Users/davidkpiano/Code/agent/examples/triage/index.ts): structured-output support ticket triage
- [`json-agent/index.ts`](/Users/davidkpiano/Code/agent/examples/json-agent/index.ts): `setupAgent.fromConfig(...)` lowering a support-ticket workflow authored as a real `.json` file (decision, text request, idle human approval step)
- [`supervisor/index.ts`](/Users/davidkpiano/Code/agent/examples/supervisor/index.ts): a routing request's structured output hands off to a format-specific worker
- [`human-in-the-loop/index.ts`](/Users/davidkpiano/Code/agent/examples/human-in-the-loop/index.ts): draft → idle review (typed `meta.interaction`) → APPROVE/REJECT redraft, with a JSON snapshot round-trip
- [`long-running-onboarding/index.ts`](/Users/davidkpiano/Code/agent/examples/long-running-onboarding/index.ts): Google ADK-style onboarding coordinator with durable typed state, two idle dormancy gates, JSON snapshot resume across days, and delegated IT provisioning
- [`file-snapshot-store/index.ts`](/Users/davidkpiano/Code/agent/examples/file-snapshot-store/index.ts): durable HITL checkpoints in a file-backed snapshot store — each idle settle writes JSON to disk and a fresh `runAgent` call resumes across turns
- [`machine-as-tool/index.ts`](/Users/davidkpiano/Code/agent/examples/machine-as-tool/index.ts): a whole agent machine embedded inside one tool call of a host harness — start/resume tools bridge a JSON-safe snapshot handle and read the typed interaction meta
- [`rag/index.ts`](/Users/davidkpiano/Code/agent/examples/rag/index.ts): retrieve (typed plain actor, keyword scoring over a sample corpus) → grounded answer, with conversational memory in context
- [`tool-calling/index.ts`](/Users/davidkpiano/Code/agent/examples/tool-calling/index.ts): model selects a tool (structured output), typed tool actors execute, progress via `onTransition`
- [`react-agent/index.ts`](/Users/davidkpiano/Code/agent/examples/react-agent/index.ts): LangGraph's `createReactAgent` as an explicit visible loop — one `reasonOrAct` request per iteration returns a call-a-tool-or-answer union, typed tool actors execute, and a step-budget guard breaks the loop with a best-effort answer
- [`plan-and-execute/index.ts`](/Users/davidkpiano/Code/agent/examples/plan-and-execute/index.ts): planner structured output, execution states iterate the plan (keeps the ReWOO evidence-map idea)
- [`sql-agent/index.ts`](/Users/davidkpiano/Code/agent/examples/sql-agent/index.ts): query generation, DB execution, and answer synthesis as separate typed states
- [`ai-sdk-host/index.ts`](/Users/davidkpiano/Code/agent/examples/ai-sdk-host/index.ts): Vercel AI SDK host actors
- [`ai-sdk-sub-agents/index.ts`](/Users/davidkpiano/Code/agent/examples/ai-sdk-sub-agents/index.ts): Vercel AI SDK ToolLoopAgent workers exposed as host-owned tools
- [`ai-sdk-marketing-chain/index.ts`](/Users/davidkpiano/Code/agent/examples/ai-sdk-marketing-chain/index.ts): Vercel AI SDK sequential chain as an explicit XState machine
- [`ai-sdk-routing/index.ts`](/Users/davidkpiano/Code/agent/examples/ai-sdk-routing/index.ts): Vercel AI SDK routing as an explicit XState machine
- [`ai-sdk-parallel-review/index.ts`](/Users/davidkpiano/Code/agent/examples/ai-sdk-parallel-review/index.ts): Vercel AI SDK parallel review as an explicit XState machine
- [`ai-sdk-orchestrator-worker/index.ts`](/Users/davidkpiano/Code/agent/examples/ai-sdk-orchestrator-worker/index.ts): Vercel AI SDK orchestrator-worker as an explicit XState machine
- [`ai-sdk-evaluator-optimizer/index.ts`](/Users/davidkpiano/Code/agent/examples/ai-sdk-evaluator-optimizer/index.ts): Vercel AI SDK evaluator-optimizer as an explicit XState machine
- [`debate-sub-agents/index.ts`](/Users/davidkpiano/Code/agent/examples/debate-sub-agents/index.ts): facilitator schedules two event-based debater sub-agents
- [`ai-sdk-game-host/index.ts`](/Users/davidkpiano/Code/agent/examples/ai-sdk-game-host/index.ts): Vercel AI SDK step runner
- [`openai-sdk-host/index.ts`](/Users/davidkpiano/Code/agent/examples/openai-sdk-host/index.ts): the executor contract implemented directly against the raw `openai` package (Chat Completions API), no Vercel AI SDK in between
- [`anthropic-sdk-host/index.ts`](/Users/davidkpiano/Code/agent/examples/anthropic-sdk-host/index.ts): the executor contract implemented directly against the raw `@anthropic-ai/sdk` package (Messages API), no Vercel AI SDK in between
- [`cloudflare-workers-ai-host/index.ts`](/Users/davidkpiano/Code/agent/examples/cloudflare-workers-ai-host/index.ts): Cloudflare Workers AI step runner
- [`cloudflare-agent-host/index.ts`](/Users/davidkpiano/Code/agent/examples/cloudflare-agent-host/index.ts): Cloudflare Agents host, persisting XState snapshots in Durable Object state
- [`subflows/index.ts`](/Users/davidkpiano/Code/agent/examples/subflows/index.ts): multi-step agent machines invoking other agent machines as XState child actors, each keeping its own executor binding
- [`river-crossing/index.ts`](/Users/davidkpiano/Code/agent/examples/river-crossing/index.ts): the machine as a verifiable environment — the model proposes moves on the wolf/goat/cabbage puzzle, guards reject illegal ones (`rejected-by-guard` + retry), and a prototype `describeMachine(...)` renders the machine's rules/states/events into the decide context
- [`todo-nl/index.ts`](/Users/davidkpiano/Code/agent/examples/todo-nl/index.ts): free-text commands mapped onto a real app's machine events (add/toggle/delete), with a `NOTHING` escape hatch and guard-rejected nonexistent ids; [`todo-nl/imperative.ts`](/Users/davidkpiano/Code/agent/examples/todo-nl/imperative.ts) is the same app without the library (raw `generateObject` while-loop) as a deliberate A/B pair
- [`context-compaction/index.ts`](/Users/davidkpiano/Code/agent/examples/context-compaction/index.ts): a self-managing chat loop — history is compacted into a running summary by an explicit `compacting` state once it exceeds a threshold, keeping only the last N turns and feeding the summary back as context
- [`guardrails/index.ts`](/Users/davidkpiano/Code/agent/examples/guardrails/index.ts): input/output guardrails as explicit gate states — validate the question before generating (refuse out-of-scope pre-generation), verify the answer after, revise at most once, never silently return unverified content (gating, vs. evaluator-optimizer's refining)

## Comparison Examples

These map LangGraph, Burr, and CrewAI Flow patterns onto XState. The dedicated per-framework ports were consolidated into pattern examples.

Multi-step agent patterns:

- [`supervisor/index.test.ts`](/Users/davidkpiano/Code/agent/examples/supervisor/index.test.ts): supervisor routing / handoff (LangGraph supervisor-handoff, Burr multi-agent collaboration, CrewAI content creator)
- [`swarm-handoff/index.test.ts`](/Users/davidkpiano/Code/agent/examples/swarm-handoff/index.test.ts): persistent multi-agent network handing off across turns
- [`plan-and-execute/index.test.ts`](/Users/davidkpiano/Code/agent/examples/plan-and-execute/index.test.ts): plan-and-execute, keeping the ReWOO evidence-map idea
- [`subflows/index.test.ts`](/Users/davidkpiano/Code/agent/examples/subflows/index.test.ts): nested subgraphs / child flows
- [`rag/index.test.ts`](/Users/davidkpiano/Code/agent/examples/rag/index.test.ts): retrieval-augmented generation (LangGraph RAG, Burr conversational RAG)
- [`tool-calling/index.test.ts`](/Users/davidkpiano/Code/agent/examples/tool-calling/index.test.ts): tool calling with intermediate progress (Burr tool calling, LangGraph tool-calling-progress)
- [`sql-agent/index.test.ts`](/Users/davidkpiano/Code/agent/examples/sql-agent/index.test.ts): SQL / tool-heavy agent workflow
- [`human-in-the-loop/index.test.ts`](/Users/davidkpiano/Code/agent/examples/human-in-the-loop/index.test.ts): human-in-the-loop plus snapshot persistence
- [`long-running-onboarding/index.test.ts`](/Users/davidkpiano/Code/agent/examples/long-running-onboarding/index.test.ts): long-running pause/resume onboarding flow with delegated IT provisioning
- [`parallel-streams/index.test.ts`](/Users/davidkpiano/Code/agent/examples/parallel-streams/index.test.ts): parallel worker streams over a side channel
- [`sse-transport/index.test.ts`](/Users/davidkpiano/Code/agent/examples/sse-transport/index.test.ts): relaying provider stream chunks over SSE

AI SDK pattern set (fan-out, routing, reflection, map-reduce shapes):

- [`ai-sdk-orchestrator-worker/index.test.ts`](/Users/davidkpiano/Code/agent/examples/ai-sdk-orchestrator-worker/index.test.ts)
- [`ai-sdk-parallel-review/index.test.ts`](/Users/davidkpiano/Code/agent/examples/ai-sdk-parallel-review/index.test.ts)
- [`ai-sdk-routing/index.test.ts`](/Users/davidkpiano/Code/agent/examples/ai-sdk-routing/index.test.ts)
- [`ai-sdk-evaluator-optimizer/index.test.ts`](/Users/davidkpiano/Code/agent/examples/ai-sdk-evaluator-optimizer/index.test.ts)
- [`ai-sdk-marketing-chain/index.test.ts`](/Users/davidkpiano/Code/agent/examples/ai-sdk-marketing-chain/index.test.ts)

New examples should use `createTextLogic(...)` for reusable LLM work and `setupAgent({ schemas, actors, requests })` for schema-first machine authoring. Decisions are authored inline in states via `src: 'agent.decide'` (state-local); to reuse one across states, share the *input builder* function (a `({ context }) => ({ model, system, prompt, allowedEvents })` fn), not an actor. There is no `decisions:` key on `setupAgent`.
