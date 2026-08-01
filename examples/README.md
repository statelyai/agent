# Examples

<!-- flat example directories derived from examples/*/metadata.json and examples/index.ts -->

Each example lives in a flat `examples/*` directory with an `index.ts` or `index.mts` entrypoint and a `metadata.json` file describing its origin and comparison purpose.

Every example is dual-mode: run it directly against a real model with `OPENAI_API_KEY=... npx tsx examples/<name>/index.ts`, while its tests use injected mocks. Nothing auto-loads `.env`; copy `.env.template` to `.env` and pass it explicitly (Node 22+):

```bash
npx tsx --env-file=.env examples/<name>/index.ts
```

Exceptions to the `OPENAI_API_KEY` + `tsx` default:

- `anthropic-sdk-host` runs against the raw `@anthropic-ai/sdk` and needs `ANTHROPIC_API_KEY` instead.
- `cloudflare-workers-ai-host` and `cloudflare-agent-host` target a Cloudflare Workers runtime (Durable Objects / Workers AI bindings), not Node/`tsx` — see each example's notes.

## Start Here

**No API key needed.** Three examples run fully scripted, in about a second each, with no key and no network:

```bash
npx tsx examples/crash-recovery/index.ts
npx tsx examples/session-actor/index.ts
npx tsx examples/preset-machine/index.ts
```

- Decisions: the model choosing exactly one legal machine event: [`twenty-questions/index.ts`](twenty-questions/index.ts)
- Hidden information + human play + machine-enforced rules: [`go-fish/index.ts`](go-fish/index.ts)
- Minimal streaming text workflow: [`joke/index.ts`](joke/index.ts)
- Authoring reusable requests, parts-based messages, and schema-typed state meta: [`email-drafter/agent-logic.ts`](email-drafter/agent-logic.ts)
- Human-in-the-loop, the idle-first way: [`human-in-the-loop/index.ts`](human-in-the-loop/index.ts)
- Checkpoint history, rewind, and forking an alternative branch over persisted snapshots: [`time-travel/index.ts`](time-travel/index.ts)
- Retrofitting a hand-rolled `while`-loop agent into a machine, one shippable step at a time: [`retrofit/index.ts`](retrofit/index.ts)
- Long-running onboarding with durable idle gates: [`long-running-onboarding/index.ts`](long-running-onboarding/index.ts)
- Running with host actors: [`ai-sdk-host/index.ts`](ai-sdk-host/index.ts)
- Machines as data: a full workflow (decision, text request, idle human step) authored as a real `.json` file: [`json-agent/index.ts`](json-agent/index.ts)
- A plain, invoke-less machine run as an agent via `getRequests` (prompts in state descriptions): [`described-workflow/index.ts`](described-workflow/index.ts)
- A library-unaware `setup(...)` machine driven as an agent by hand (no `setupAgent`), with `getAcceptedEvents` + `resolveDecision`: [`plain-xstate/index.ts`](plain-xstate/index.ts)
- Hosts and executors guide: [`../docs/hosts.md`](../docs/hosts.md)
- Tracing a run to LangSmith over OpenTelemetry (real OTel SDK + OTLP exporter via `@statelyai/agent/otel`; keyless it exports to memory and prints the span tree): [`langsmith-otel/index.ts`](langsmith-otel/index.ts)
- Framework comparison examples: [`supervisor/index.ts`](supervisor/index.ts), [`plan-and-execute/index.ts`](plan-and-execute/index.ts), [`rag/index.ts`](rag/index.ts), [`tool-calling/index.ts`](tool-calling/index.ts)

## XState Examples

These use `setupAgent(...)` (or plain XState `setup(...)` plus `createTextLogic(...)`) from `@statelyai/agent`. The runtime is flexible: use `runAgent(...)`/`createActor(...)` locally, provide different host actors in apps, or persist XState snapshots in a platform adapter.

- [`twenty-questions/index.ts`](twenty-questions/index.ts): decision loop with machine-held context, typed model aliases, final-turn guess enforcement, scoring, play-again reset, and machine-owned user prompts
- [`email-drafter/agent-logic.ts`](email-drafter/agent-logic.ts): typed email workflow with independently testable requests
- [`email-drafter-inspector/index.ts`](email-drafter-inspector/index.ts): the email-drafter machine run as one live `createActor` session wired to `createInspector`, so the whole flow is visible in the Stately Inspector (works without an API key via heuristic fallbacks)
- [`game-agent/index.ts`](game-agent/index.ts): games as machines, two lessons in one file — a turn-based combat agent with decision `allowedEvents` computed from context (HEAL only when low on HP), and a rock-paper-scissors agent (`rpsMachine`) that reduces each round's events into a `context.history` log the decide prompt reads back, so the saved event history is the only way the model can infer the opponent's pattern and win
- [`go-fish/index.ts`](go-fish/index.ts): two-player hidden-information game with a checking-win → agent → human loop; the machine owns the deck, shows the human their hand, validates moves, and forms books
- [`joke/index.ts`](joke/index.ts): minimal streaming text workflow
- [`triage/index.ts`](triage/index.ts): structured-output support ticket triage
- [`preset-machine/index.ts`](preset-machine/index.ts): `createParallelMachine` from `@statelyai/agent/machines` — two review branches run concurrently as regions of one parallel state and join keyed by branch name; the factory returns an ordinary machine, and a scripted executor keeps the run keyless
- [`json-agent/index.ts`](json-agent/index.ts): `setupAgent.fromConfig(...)` lowering a support-ticket workflow authored as a real `.json` file (decision, text request, idle human approval step)
- [`described-workflow/index.ts`](described-workflow/index.ts): a plain `createMachine` with zero invokes run as an agent via `runAgent({ getRequests })`, prompts read from state descriptions/meta, message log stamped on `snapshot.messages`
- [`plain-xstate/index.ts`](plain-xstate/index.ts): a normal XState v6 `setup(...)` machine (a promise-shaped invoke, an `on: { APPROVE, REVISE }` decision state with a guarded transition, a final state, and zero knowledge of `@statelyai/agent`) adopted as an agent without `setupAgent`: bind the actor via `machine.provide(...)`, then drive the decision with `getAcceptedEvents(snapshot)` + `resolveDecision(...)` gated by `snapshot.can(event)`
- [`supervisor/index.ts`](supervisor/index.ts): a routing request's structured output hands off to a format-specific worker
- [`hierarchical-teams/index.ts`](hierarchical-teams/index.ts): two-level supervisors — a research team routes SEARCH/SCRAPE/FINISH via `agent.decide` over a bounded worker budget, under a coordinator that invokes the team machines through typed boundaries and can send one bounded revision round back to research
- [`human-in-the-loop/index.ts`](human-in-the-loop/index.ts): draft → idle review (typed `meta.interaction`) → APPROVE/REJECT redraft, with a JSON snapshot round-trip
- [`long-running-onboarding/index.ts`](long-running-onboarding/index.ts): Google ADK-style onboarding coordinator with durable typed state, two idle dormancy gates, JSON snapshot resume across days, and delegated IT provisioning
- [`crash-recovery/index.ts`](crash-recovery/index.ts): events-only resume — persist replayable log entries as they happen, "crash" mid-request, then recover with `runAgent({ events })` alone: recorded results replay, the in-flight request re-executes idempotently
- [`session-actor/index.ts`](session-actor/index.ts): `createAgentActor` session mode — one live actor across turns (send an event to re-open the cycle, `settled()` at each quiescence), with a single replayable log and cumulative usage spanning the whole session
- [`file-snapshot-store/index.ts`](file-snapshot-store/index.ts): durable HITL checkpoints in a file-backed snapshot store: each idle settle writes JSON to disk and a fresh `runAgent` call resumes across turns
- [`machine-as-tool/index.ts`](machine-as-tool/index.ts): a whole agent machine embedded inside one tool call of a host harness: start/resume tools bridge a JSON-safe snapshot handle and read the typed interaction meta
- [`rag/index.ts`](rag/index.ts): retrieve (typed plain actor, keyword scoring over a sample corpus) → grounded answer, with conversational memory in context
- [`corrective-rag/index.ts`](corrective-rag/index.ts): LangGraph's CRAG tutorial as explicit states: retrieve → grade documents → conditional correction branch (rewrite query → web-search fallback) → grounded generate, every model call with a degrading `onError`
- [`adaptive-rag/index.ts`](adaptive-rag/index.ts): LangGraph adaptive RAG as route → retrieve/search → grade → bounded rewrite → generate → groundedness/usefulness verification
- [`deep-research/index.ts`](deep-research/index.ts): plan 2-4 complementary searches → one dynamically spawned researcher per query → coverage reflection → optional targeted follow-up → sourced report; search remains host-owned
- [`reflection-writer/index.ts`](reflection-writer/index.ts): LangGraph's Reflection tutorial (essay writer): generate ↔ critique loop with a typed `maxRevisions` bound and structured `{ critique, satisfied }` early exit, transcript accumulated as role-flipped messages
- [`code-assistant/index.ts`](code-assistant/index.ts): LangGraph's self-correcting code-assistant tutorial as explicit states: generate `{ code, explanation }` (structured output) → sandboxed `node:vm` execute/check against unit tests (typed plain actor, empty sandbox) → conditional pass/fail/reflect branch, bounded by a typed `maxAttempts`, exhaustion ends in a `failed` outcome carrying the last failures
- [`customer-support/index.ts`](customer-support/index.ts): the core of LangGraph's customer-support tutorial: intent routing (typed union), safe Q&A with request-level tools, and sensitive actions gated behind an idle `confirming` state (`interrupt_before` as a real state: persist snapshot, resume with APPROVE/DENY)
- [`review-tool-calls/index.ts`](review-tool-calls/index.ts): LangGraph's "review tool calls" HITL pattern — the model proposes a `sendRefund` tool call, an idle `reviewing` state gates it, and the human resumes with APPROVE (run as-is), EDIT (partial override merged over the args), or REJECT (feedback back to the model for one bounded revision); snapshot round-trip mid-review
- [`time-travel/index.ts`](time-travel/index.ts): LangGraph's time-travel how-to as a list of persisted snapshots — checkpoint each idle/done settle, rewind to checkpoint #1, and fork a divergent branch (approve the original draft) while the main branch stays unchanged
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
- [`ai-sdk-game-host/index.ts`](ai-sdk-game-host/index.ts): canonical thin-loop wiring over the Vercel AI SDK: a journal + `getAgentEffects` + `executeAgentRequest`/`resolveDecision`, executing and folding one effect per frontier
- [`openai-sdk-host/index.ts`](openai-sdk-host/index.ts): the executor contract implemented directly against the raw `openai` package (Chat Completions API), no Vercel AI SDK in between
- [`anthropic-sdk-host/index.ts`](anthropic-sdk-host/index.ts): the executor contract implemented directly against the raw `@anthropic-ai/sdk` package (Messages API), no Vercel AI SDK in between
- [`cloudflare-workers-ai-host/index.ts`](cloudflare-workers-ai-host/index.ts): durable thin-loop host on Cloudflare Workers AI: persists only the event-log journal and resumes by `replay`
- [`cloudflare-agent-host/index.ts`](cloudflare-agent-host/index.ts): Cloudflare Agents host, persisting XState snapshots in Durable Object state
- [`subflows/index.ts`](subflows/index.ts): multi-step agent machines invoking other agent machines as XState child actors, each keeping its own executor binding
- [`river-crossing/index.ts`](river-crossing/index.ts): the machine as a verifiable environment: the model proposes moves on the wolf/goat/cabbage puzzle, guards reject illegal ones (`rejected-by-guard` + retry), and a prototype `describeMachine(...)` renders the machine's rules/states/events into the decide context
- [`todo-nl/index.ts`](todo-nl/index.ts): free-text commands mapped onto a real app's machine events (add/toggle/delete) via one `agent.plan` invoke: a multi-action command drives several plan steps in order, the built-in done move ends the plan, and nonexistent ids are guard-rejected mid-plan with a retry; [`todo-nl/imperative.ts`](todo-nl/imperative.ts) is the same app without the library (raw `generateObject` while-loop) as a deliberate A/B pair
- [`context-compaction/index.ts`](context-compaction/index.ts): a self-managing chat loop: history is compacted into a running summary by an explicit `compacting` state once it exceeds a threshold, keeping only the last N turns and feeding the summary back as context
- [`guardrails/index.ts`](guardrails/index.ts): input/output guardrails as explicit gate states: validate the question before generating (refuse out-of-scope pre-generation), verify the answer after, revise at most once, never silently return unverified content (gating, vs. evaluator-optimizer's refining)
- [`lats/index.ts`](lats/index.ts): Language Agent Tree Search as bounded UCB-style selection → candidate expansion → reflection scoring until solved or out of rollout budget
- [`simulated-user-evaluation/index.ts`](simulated-user-evaluation/index.ts): bounded chatbot ↔ simulated-user loop followed by an independent transcript judge, without LangSmith services
- [`braintrust-evals/index.ts`](braintrust-evals/index.ts): Braintrust `Eval()` over the unmodified email-drafter machine — a dataset, a simulated user answering whatever interaction the machine waits on, and scorers over `result.output`, the state path, the `result.events` trajectory, and `result.usage`; runs keyless and offline (`noSendLogs` + scripted executors), `OPENAI_API_KEY` scores the real model, `BRAINTRUST_API_KEY` uploads the experiment. See [Evals](../docs/evals.md)
- [`trading-team/index.ts`](trading-team/index.ts): TradingAgents-style composite of parallel analysts → a bounded multi-round bull/bear debate → trader proposal → risk review that can reject and force one revision → final approve-or-reject decision, with data and execution host-owned

## Framework Hosts

The same agent machine served from real app frameworks, in both modes: controlled (`runAgent` per request, snapshot persisted between requests) and uncontrolled (`provideExecutors` + `createActor`, the app owns the actor).

- [`express-host/index.ts`](express-host/index.ts): controlled mode over HTTP: an Express route runs/resumes an agent via `runAgent`; idle + persisted snapshot = human-in-the-loop across requests
- [`hono-host/index.ts`](hono-host/index.ts): the express-host shape in Hono, plus a streaming endpoint piping `onChunk` into the response body
- [`ai-sdk-ui-stream/index.ts`](ai-sdk-ui-stream/index.ts): bridge a run to the Vercel AI SDK v6 UI message stream (text parts + `data-agent-state` parts) behind a `POST /api/chat` handler a `useChat` client consumes unchanged — the UI-protocol sibling of `sse-transport`
- [`next-host/app/api/agent/route.ts`](next-host/app/api/agent/route.ts): Next.js App Router route handlers running an agent; snapshot persisted across the stateless request boundary (workspace package with a real `next` dependency)
- [`tanstack-start-host/index.ts`](tanstack-start-host/index.ts): TanStack Start server functions (`startAgent`/`resumeAgent`) invoking `runAgent` (workspace package with a real `@tanstack/react-start` dependency)
- [`react-uncontrolled/index.tsx`](react-uncontrolled/index.tsx): uncontrolled mode: `createActor(provideExecutors(machine, executors))` drives itself; React observes snapshots, sends user events, and renders streamed text
- [`tanstack-ai-stream/index.ts`](tanstack-ai-stream/index.ts): stream a machine run to a UI: a TanStack Start API route bridges `runAgent`'s seams to TanStack AI's AG-UI wire protocol (`onChunk` becomes `TEXT_MESSAGE_CONTENT` deltas, transitions become `STEP_STARTED`/`STEP_FINISHED`) served over SSE to an unmodified `useChat` client (workspace package with real `@tanstack/ai` and `@tanstack/ai-react` dependencies)
- [`flue-host/index.ts`](flue-host/index.ts): Flue 2 (hooks-based `defineAgent`), two ways (local `@flue/runtime` shims). [`machine-owned.ts`](flue-host/machine-owned.ts): the email-drafter machine owns the workflow; the agent gets `start_workflow`/`resume_workflow` bridge tools over `runAgent`. [`flue-owned.ts`](flue-host/flue-owned.ts): Flue's hooks own per-step model/skills/tools; a ~10-line steps machine replaces the blog's `usePersistentState('step', ...)` string, making transitions declared, the step switch exhaustive, and events inferred (`EventFromLogic`)
- [`eve-host/agent.ts`](eve-host/agent.ts): the same start/resume tool bridge in Eve's folder convention (`instructions.md` + `agent.ts` + `tools/start_workflow.ts` / `tools/resume_workflow.ts`); the machine owns draft legality, the Eve agent converses (local `eve` shims)
- [`mastra-host/index.ts`](mastra-host/index.ts): the same bridge on the real `@mastra/core` (`createTool` + `Agent`, no shims); snapshots persisted in a `Map` keyed by handle, and the event to resume with is derived from the machine's own `meta.interaction`
- [`langchain-host/index.ts`](langchain-host/index.ts): LangChain and machine-owned control flow together, both directions — `createLangChainExecutors` wraps any LangChain `BaseChatModel` into the `{ generateText, streamText, decide }` contract (your model config, callbacks, and env-var LangSmith tracing keep working), and `start_workflow`/`resume_workflow` hand a LangChain 1.x `createAgent` loop the email-drafter machine as two tools; real `@langchain/core` + `@langchain/openai` + `langchain`, keyless via a scripted LangChain model

## Comparison Examples

These map LangGraph, Burr, and CrewAI Flow patterns onto XState. The dedicated per-framework ports were consolidated into pattern examples.

Multi-step agent patterns:

- [`supervisor/index.ts`](supervisor/index.ts): supervisor routing / handoff (LangGraph supervisor-handoff, Burr multi-agent collaboration, CrewAI content creator)
- [`hierarchical-teams/index.ts`](hierarchical-teams/index.ts): supervisor-routed teams — a research-team `agent.decide` loops workers (SEARCH/SCRAPE/FINISH) under a coordinator supervisor, each team a nested child machine with typed boundaries
- [`trading-team/index.ts`](trading-team/index.ts): a complete organizational workflow combining parallel specialists, a multi-round debate, proposal, and a reject-and-revise risk loop
- [`swarm-handoff/index.ts`](swarm-handoff/index.ts): persistent multi-agent network handing off across turns
- [`plan-and-execute/index.ts`](plan-and-execute/index.ts): plan-and-execute, keeping the ReWOO evidence-map idea
- [`subflows/index.ts`](subflows/index.ts): nested subgraphs / child flows
- [`fan-out/index.ts`](fan-out/index.ts): dynamic runtime fan-out / map-reduce (LangGraph `Send`): a planner produces N subtopics, the machine spawns one live child branch per subtopic off `actors` (no per-branch executor pre-binding), and a reducer composes the summaries into one digest
- [`rag/index.ts`](rag/index.ts): retrieval-augmented generation (LangGraph RAG, Burr conversational RAG)
- [`corrective-rag/index.ts`](corrective-rag/index.ts): corrective RAG (LangGraph CRAG tutorial: grade docs, rewrite query, web-search fallback)
- [`adaptive-rag/index.ts`](adaptive-rag/index.ts): adaptive RAG (route local vs web, grade retrieval and generation, bounded rewrite)
- [`deep-research/index.ts`](deep-research/index.ts): iterative deep research (plan N queries, dynamic parallel research, reflect, follow up, synthesize)
- [`reflection-writer/index.ts`](reflection-writer/index.ts): reflection loop (LangGraph reflection essay-writer tutorial)
- [`code-assistant/index.ts`](code-assistant/index.ts): self-correcting code generation (LangGraph code-assistant tutorial: generate, sandboxed execute/check, reflect-and-regenerate on failure)
- [`lats/index.ts`](lats/index.ts): Language Agent Tree Search (selection, candidate expansion, reflection scores, budgeted termination)
- [`simulated-user-evaluation/index.ts`](simulated-user-evaluation/index.ts): multi-agent chatbot simulation and evaluation, excluding hosted LangSmith experiment machinery
- [`customer-support/index.ts`](customer-support/index.ts): customer-support bot with sensitive-action approval (LangGraph flagship tutorial's `interrupt_before` pattern)
- [`tool-calling/index.ts`](tool-calling/index.ts): tool calling with intermediate progress (Burr tool calling, LangGraph tool-calling-progress)
- [`sql-agent/index.ts`](sql-agent/index.ts): SQL / tool-heavy agent workflow
- [`human-in-the-loop/index.ts`](human-in-the-loop/index.ts): human-in-the-loop plus snapshot persistence
- [`review-tool-calls/index.ts`](review-tool-calls/index.ts): approve / edit-before-run / reject-with-feedback over a proposed tool call (LangGraph's `interrupt` + `Command(resume={...})`)
- [`time-travel/index.ts`](time-travel/index.ts): time travel — view checkpoint history, rewind to a past checkpoint, fork an alternative branch (LangGraph time-travel how-to)
- [`long-running-onboarding/index.ts`](long-running-onboarding/index.ts): long-running pause/resume onboarding flow with delegated IT provisioning
- [`parallel-streams/index.ts`](parallel-streams/index.ts): parallel worker streams over a side channel
- [`sse-transport/index.ts`](sse-transport/index.ts): relaying provider stream chunks over SSE

AI SDK pattern set (fan-out, routing, reflection, map-reduce shapes):

- [`ai-sdk-orchestrator-worker/index.ts`](ai-sdk-orchestrator-worker/index.ts)
- [`ai-sdk-parallel-review/index.ts`](ai-sdk-parallel-review/index.ts)
- [`ai-sdk-routing/index.ts`](ai-sdk-routing/index.ts)
- [`ai-sdk-evaluator-optimizer/index.ts`](ai-sdk-evaluator-optimizer/index.ts)
- [`ai-sdk-marketing-chain/index.ts`](ai-sdk-marketing-chain/index.ts)

<!-- setupAgent config keys and decision authoring from src/setup-agent.ts and src/decision.ts -->

New examples should use `createTextLogic(...)` for reusable LLM work and `setupAgent({ schemas, actors, requests })` for schema-first machine authoring. Decisions are authored inline in states via `src: 'agent.decide'` (state-local); to reuse one across states, share the _input builder_ function (a `({ context }) => ({ model, system, prompt, allowedEvents })` fn), not an actor. There is no `decisions:` key on `setupAgent`.
