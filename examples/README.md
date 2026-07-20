# Examples

<!-- flat example directories derived from examples/*/metadata.json and examples/index.ts -->

Each example lives in a flat `examples/*` directory with an `index.ts` or `index.mts` entrypoint and a `metadata.json` file describing its origin and comparison purpose.

Every example is dual-mode: run it directly against a real model with `OPENAI_API_KEY=... npx tsx examples/<name>/index.ts`, while its tests use injected mocks. Exceptions to the `OPENAI_API_KEY` + `tsx` default:

- `anthropic-sdk-host` runs against the raw `@anthropic-ai/sdk` and needs `ANTHROPIC_API_KEY` instead.
- `cloudflare-workers-ai-host` and `cloudflare-agent-host` target a Cloudflare Workers runtime (Durable Objects / Workers AI bindings), not Node/`tsx` — see each example's notes.

## Start Here

- Decisions: the model choosing exactly one legal machine event: [`twenty-questions/index.ts`](twenty-questions/index.ts)
- Hidden information + human play + machine-enforced rules: [`go-fish/index.ts`](go-fish/index.ts)
- Minimal streaming text workflow: [`joke/index.ts`](joke/index.ts)
- Authoring reusable requests, parts-based messages, and schema-typed state meta: [`email-drafter/index.ts`](email-drafter/index.ts)
- Human-in-the-loop, the idle-first way: [`human-in-the-loop/index.ts`](human-in-the-loop/index.ts)
- Long-running onboarding with durable idle gates: [`long-running-onboarding/index.ts`](long-running-onboarding/index.ts)
- Running with host actors: [`ai-sdk-host/index.ts`](ai-sdk-host/index.ts)
- Machines as data: a full workflow (decision, text request, idle human step) authored as a real `.json` file: [`json-agent/index.ts`](json-agent/index.ts)
- A plain, invoke-less machine run as an agent via `getRequests` (prompts in state descriptions): [`described-workflow/index.ts`](described-workflow/index.ts)
- A library-unaware `setup(...)` machine driven as an agent by hand (no `setupAgent`), with `getAcceptedEvents` + `resolveDecision`: [`plain-xstate/index.ts`](plain-xstate/index.ts)
- Hosts and executors guide: [`../docs/hosts.md`](../docs/hosts.md)
- Framework comparison examples: [`supervisor/index.ts`](supervisor/index.ts), [`plan-and-execute/index.ts`](plan-and-execute/index.ts), [`rag/index.ts`](rag/index.ts), [`tool-calling/index.ts`](tool-calling/index.ts)

## XState Examples

These use `setupAgent(...)` (or plain XState `setup(...)` plus `createTextLogic(...)`) from `@statelyai/agent`. The runtime is flexible: use `runAgent(...)`/`createActor(...)` locally, provide different host actors in apps, or persist XState snapshots in a platform adapter.

- [`twenty-questions/index.ts`](twenty-questions/index.ts): decision loop with machine-held context, typed model aliases, final-turn guess enforcement, scoring, play-again reset, and machine-owned user prompts
- [`email-drafter/index.ts`](email-drafter/index.ts): typed email workflow with independently testable requests
- [`email-drafter-inspector/index.ts`](email-drafter-inspector/index.ts): the email-drafter machine run as one live `createActor` session wired to `createWebSocketInspector`, so the whole flow is visible in the Stately Inspector (works without an API key via heuristic fallbacks)
- [`game-agent/index.ts`](game-agent/index.ts): games as machines, two lessons in one file — a turn-based combat agent with decision `allowedEvents` computed from context (HEAL only when low on HP), and a rock-paper-scissors agent (`rpsMachine`) that reduces each round's events into a `context.history` log the decide prompt reads back, so the saved event history is the only way the model can infer the opponent's pattern and win
- [`go-fish/index.ts`](go-fish/index.ts): two-player hidden-information game with a checking-win → agent → human loop; the machine owns the deck, shows the human their hand, validates moves, and forms books
- [`joke/index.ts`](joke/index.ts): minimal streaming text workflow
- [`triage/index.ts`](triage/index.ts): structured-output support ticket triage
- [`json-agent/index.ts`](json-agent/index.ts): `setupAgent.fromConfig(...)` lowering a support-ticket workflow authored as a real `.json` file (decision, text request, idle human approval step)
- [`described-workflow/index.ts`](described-workflow/index.ts): a plain `createMachine` with zero invokes run as an agent via `runAgent({ getRequests })`, prompts read from state descriptions/meta, message log stamped on `snapshot.messages`
- [`plain-xstate/index.ts`](plain-xstate/index.ts): a normal XState v5 `setup(...)` machine (a promise-shaped invoke, an `on: { APPROVE, REVISE }` decision state with a guarded transition, a final state, and zero knowledge of `@statelyai/agent`) adopted as an agent without `setupAgent`: bind the actor via `machine.provide(...)`, then drive the decision with `getAcceptedEvents(snapshot)` + `resolveDecision(...)` gated by `snapshot.can(event)`
- [`supervisor/index.ts`](supervisor/index.ts): a routing request's structured output hands off to a format-specific worker
- [`human-in-the-loop/index.ts`](human-in-the-loop/index.ts): draft → idle review (typed `meta.interaction`) → APPROVE/REJECT redraft, with a JSON snapshot round-trip
- [`long-running-onboarding/index.ts`](long-running-onboarding/index.ts): Google ADK-style onboarding coordinator with durable typed state, two idle dormancy gates, JSON snapshot resume across days, and delegated IT provisioning
- [`file-snapshot-store/index.ts`](file-snapshot-store/index.ts): durable HITL checkpoints in a file-backed snapshot store: each idle settle writes JSON to disk and a fresh `runAgent` call resumes across turns
- [`machine-as-tool/index.ts`](machine-as-tool/index.ts): a whole agent machine embedded inside one tool call of a host harness: start/resume tools bridge a JSON-safe snapshot handle and read the typed interaction meta
- [`rag/index.ts`](rag/index.ts): retrieve (typed plain actor, keyword scoring over a sample corpus) → grounded answer, with conversational memory in context
- [`corrective-rag/index.ts`](corrective-rag/index.ts): LangGraph's CRAG tutorial as explicit states: retrieve → grade documents → conditional correction branch (rewrite query → web-search fallback) → grounded generate, every model call with a degrading `onError`
- [`reflection-writer/index.ts`](reflection-writer/index.ts): LangGraph's Reflection tutorial (essay writer): generate ↔ critique loop with a typed `maxRevisions` bound and structured `{ critique, satisfied }` early exit, transcript accumulated as role-flipped messages
- [`customer-support/index.ts`](customer-support/index.ts): the core of LangGraph's customer-support tutorial: intent routing (typed union), safe Q&A with request-level tools, and sensitive actions gated behind an idle `confirming` state (`interrupt_before` as a real state: persist snapshot, resume with APPROVE/DENY)
- [`tool-calling/index.ts`](tool-calling/index.ts): model selects a tool (structured output), typed tool actors execute, progress via `onTransition`
- [`react-agent/index.ts`](react-agent/index.ts): LangGraph's `createReactAgent` as an explicit visible loop: one `reasonOrAct` request per iteration returns a call-a-tool-or-answer union, typed tool actors execute, and a step-budget guard breaks the loop with a best-effort answer
- [`plan-and-execute/index.ts`](plan-and-execute/index.ts): planner structured output, execution states iterate the plan (keeps the ReWOO evidence-map idea)
- [`sql-agent/index.ts`](sql-agent/index.ts): query generation, DB execution, and answer synthesis as separate typed states
- [`ai-sdk-host/index.ts`](ai-sdk-host/index.ts): Vercel AI SDK host actors
- [`ai-sdk-sub-agents/index.ts`](ai-sdk-sub-agents/index.ts): Vercel AI SDK ToolLoopAgent workers exposed as host-owned tools
- [`ai-sdk-marketing-chain/index.ts`](ai-sdk-marketing-chain/index.ts): Vercel AI SDK sequential chain as an explicit XState machine
- [`ai-sdk-routing/index.ts`](ai-sdk-routing/index.ts): Vercel AI SDK routing as an explicit XState machine
- [`ai-sdk-parallel-review/index.ts`](ai-sdk-parallel-review/index.ts): Vercel AI SDK parallel review as an explicit XState machine
- [`ai-sdk-orchestrator-worker/index.ts`](ai-sdk-orchestrator-worker/index.ts): Vercel AI SDK orchestrator-worker as an explicit XState machine
- [`ai-sdk-evaluator-optimizer/index.ts`](ai-sdk-evaluator-optimizer/index.ts): Vercel AI SDK evaluator-optimizer as an explicit XState machine
- [`debate-sub-agents/index.ts`](debate-sub-agents/index.ts): facilitator schedules two event-based debater sub-agents
- [`ai-sdk-game-host/index.ts`](ai-sdk-game-host/index.ts): Vercel AI SDK step runner
- [`openai-sdk-host/index.ts`](openai-sdk-host/index.ts): the executor contract implemented directly against the raw `openai` package (Chat Completions API), no Vercel AI SDK in between
- [`anthropic-sdk-host/index.ts`](anthropic-sdk-host/index.ts): the executor contract implemented directly against the raw `@anthropic-ai/sdk` package (Messages API), no Vercel AI SDK in between
- [`cloudflare-workers-ai-host/index.ts`](cloudflare-workers-ai-host/index.ts): Cloudflare Workers AI step runner
- [`cloudflare-agent-host/index.ts`](cloudflare-agent-host/index.ts): Cloudflare Agents host, persisting XState snapshots in Durable Object state
- [`subflows/index.ts`](subflows/index.ts): multi-step agent machines invoking other agent machines as XState child actors, each keeping its own executor binding
- [`river-crossing/index.ts`](river-crossing/index.ts): the machine as a verifiable environment: the model proposes moves on the wolf/goat/cabbage puzzle, guards reject illegal ones (`rejected-by-guard` + retry), and a prototype `describeMachine(...)` renders the machine's rules/states/events into the decide context
- [`todo-nl/index.ts`](todo-nl/index.ts): free-text commands mapped onto a real app's machine events (add/toggle/delete) via one `agent.plan` invoke: a multi-action command drives several plan steps in order, the built-in done move ends the plan, and nonexistent ids are guard-rejected mid-plan with a retry; [`todo-nl/imperative.ts`](todo-nl/imperative.ts) is the same app without the library (raw `generateObject` while-loop) as a deliberate A/B pair
- [`context-compaction/index.ts`](context-compaction/index.ts): a self-managing chat loop: history is compacted into a running summary by an explicit `compacting` state once it exceeds a threshold, keeping only the last N turns and feeding the summary back as context
- [`guardrails/index.ts`](guardrails/index.ts): input/output guardrails as explicit gate states: validate the question before generating (refuse out-of-scope pre-generation), verify the answer after, revise at most once, never silently return unverified content (gating, vs. evaluator-optimizer's refining)

## Framework Hosts

The same agent machine served from real app frameworks, in both modes: controlled (`runAgent` per request, snapshot persisted between requests) and uncontrolled (`provideExecutors` + `createActor`, the app owns the actor).

- [`express-host/index.ts`](express-host/index.ts): controlled mode over HTTP: an Express route runs/resumes an agent via `runAgent`; idle + persisted snapshot = human-in-the-loop across requests
- [`hono-host/index.ts`](hono-host/index.ts): the express-host shape in Hono, plus a streaming endpoint piping `onChunk` into the response body
- [`next-host/app/api/agent/route.ts`](next-host/app/api/agent/route.ts): Next.js App Router route handlers running an agent; snapshot persisted across the stateless request boundary (typechecks standalone via local shims)
- [`tanstack-start-host/index.ts`](tanstack-start-host/index.ts): TanStack Start server functions (`startAgent`/`resumeAgent`) invoking `runAgent` (local `createServerFn` shim)
- [`react-uncontrolled/index.tsx`](react-uncontrolled/index.tsx): uncontrolled mode: `createActor(provideExecutors(machine, executors))` drives itself; React observes snapshots, sends user events, and renders streamed text
- [`flue-host/index.ts`](flue-host/index.ts): a Flue (`defineAgent` + `defineTool`) LLM agent with two tools bridging to a machine: `start_workflow` runs `runAgent` to idle/done and returns a JSON-safe handle, `resume_workflow` revives it with the human's decision (local `@flue/runtime` shims)
- [`eve-host/agent.ts`](eve-host/agent.ts): the same start/resume tool bridge in Eve's folder convention (`instructions.md` + `agent.ts` + `tools/start_workflow.ts` / `tools/resume_workflow.ts`); the machine owns refund legality, the Eve agent converses (local `eve` shims)

## Comparison Examples

These map LangGraph, Burr, and CrewAI Flow patterns onto XState. The dedicated per-framework ports were consolidated into pattern examples.

Multi-step agent patterns:

- [`supervisor/index.ts`](supervisor/index.ts): supervisor routing / handoff (LangGraph supervisor-handoff, Burr multi-agent collaboration, CrewAI content creator)
- [`swarm-handoff/index.ts`](swarm-handoff/index.ts): persistent multi-agent network handing off across turns
- [`plan-and-execute/index.ts`](plan-and-execute/index.ts): plan-and-execute, keeping the ReWOO evidence-map idea
- [`subflows/index.ts`](subflows/index.ts): nested subgraphs / child flows
- [`fan-out/index.ts`](fan-out/index.ts): dynamic runtime fan-out / map-reduce (LangGraph `Send`): a planner produces N subtopics, the machine spawns one live child branch per subtopic, and a reducer composes the summaries into one digest
- [`rag/index.ts`](rag/index.ts): retrieval-augmented generation (LangGraph RAG, Burr conversational RAG)
- [`corrective-rag/index.ts`](corrective-rag/index.ts): corrective RAG (LangGraph CRAG tutorial: grade docs, rewrite query, web-search fallback)
- [`reflection-writer/index.ts`](reflection-writer/index.ts): reflection loop (LangGraph reflection essay-writer tutorial)
- [`customer-support/index.ts`](customer-support/index.ts): customer-support bot with sensitive-action approval (LangGraph flagship tutorial's `interrupt_before` pattern)
- [`tool-calling/index.ts`](tool-calling/index.ts): tool calling with intermediate progress (Burr tool calling, LangGraph tool-calling-progress)
- [`sql-agent/index.ts`](sql-agent/index.ts): SQL / tool-heavy agent workflow
- [`human-in-the-loop/index.ts`](human-in-the-loop/index.ts): human-in-the-loop plus snapshot persistence
- [`long-running-onboarding/index.ts`](long-running-onboarding/index.ts): long-running pause/resume onboarding flow with delegated IT provisioning
- [`parallel-streams/index.ts`](parallel-streams/index.ts): parallel worker streams over a side channel
- [`sse-transport/index.ts`](sse-transport/index.ts): relaying provider stream chunks over SSE

AI SDK pattern set (fan-out, routing, reflection, map-reduce shapes):

- [`ai-sdk-orchestrator-worker/index.ts`](ai-sdk-orchestrator-worker/index.ts)
- [`ai-sdk-parallel-review/index.ts`](ai-sdk-parallel-review/index.ts)
- [`ai-sdk-routing/index.ts`](ai-sdk-routing/index.ts)
- [`ai-sdk-evaluator-optimizer/index.ts`](ai-sdk-evaluator-optimizer/index.ts)
- [`ai-sdk-marketing-chain/index.ts`](ai-sdk-marketing-chain/index.ts)

New examples should use `createTextLogic(...)` for reusable LLM work and `setupAgent({ schemas, actors, requests })` for schema-first machine authoring. Decisions are authored inline in states via `src: 'agent.decide'` (state-local); to reuse one across states, share the _input builder_ function (a `({ context }) => ({ model, system, prompt, allowedEvents })` fn), not an actor. There is no `decisions:` key on `setupAgent`.
