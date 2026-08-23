# Examples

<!-- flat example directories derived from examples/*/metadata.json and examples/index.ts -->

Each example lives in a flat `examples/*` directory with an `index.ts` or `index.mts` entrypoint and a `metadata.json` file describing its origin and comparison purpose.

Model-backed examples run directly with `OPENAI_API_KEY=... npx tsx examples/<name>/index.ts`, while their tests use injected mocks. Verification, migration, and scripted-eval examples are intentionally keyless. Nothing auto-loads `.env`; copy `.env.template` to `.env` and pass it explicitly (Node 22+):

```bash
npx tsx --env-file=.env examples/<name>/index.ts
```

Exceptions to the `OPENAI_API_KEY` + `tsx` default:

- `anthropic-sdk-host` runs against the raw `@anthropic-ai/sdk` and needs `ANTHROPIC_API_KEY` instead.
- `cloudflare-workers-ai-host` and `cloudflare-agent-host` target a Cloudflare Workers runtime (Durable Objects and Workers AI bindings), not Node or `tsx`. See each example's notes.

## Start here

**No API key needed.** Six examples run fully scripted, in about a second each, with no key and no network:

```bash
npx tsx examples/crash-recovery/index.ts
npx tsx examples/session-actor/index.ts
npx tsx examples/preset-machine/index.ts
npx tsx examples/verification/index.ts
npx tsx examples/snapshot-migration/index.ts
npx tsx examples/seam-scoring/index.ts
```

Good first reads: [`twenty-questions`](twenty-questions/index.ts), [`go-fish`](go-fish/index.ts), [`joke`](joke/index.ts), [`email-drafter`](email-drafter/agent-logic.ts), [`human-in-the-loop`](human-in-the-loop/index.ts), [`retrofit`](retrofit/index.ts), [`json-agent`](json-agent/index.ts), [`ai-sdk-host`](ai-sdk-host/index.ts). The [hosts and executors guide](../docs/hosts.md) explains what the runtime side of each one is doing.

## Agent machines

- [`twenty-questions/index.ts`](twenty-questions/index.ts): a decision loop with guard-enforced legality where every player turn is an idle state offering buttons or free text a classifier interprets.
- [`go-fish/index.ts`](go-fish/index.ts): a hidden-information card game where the model asks and the machine enforces the rules, with the human's turn as an idle state resumed by a free-text `ASK` event.
- [`just-one/index.ts`](just-one/index.ts): the cooperative word game where three clue-givers write simultaneously as isolated parallel regions, and the machine strikes every duplicate clue before the human guesser sees it.
- [`chameleon/index.ts`](chameleon/index.ts): the hidden-role word game where the chameleon's request input has no `secretWord` field at all, so the secret cannot reach it, and the human detective votes from an idle state.
- [`game-agent/index.ts`](game-agent/index.ts): a turn-based combat machine whose decision `allowedEvents` are computed from context, plus an interactive rock-paper-scissors match driven from `meta.interaction` buttons.
- [`game-loop-agent/index.ts`](game-loop-agent/index.ts): a long-lived player agent invoked once at the game machine's `playing` state, so one agent spans substates and rounds.
- [`river-crossing/index.ts`](river-crossing/index.ts): the machine as a verifiable environment where guards reject illegal wolf, goat, and cabbage crossings and the run narrates both banks.
- [`todo-nl/index.ts`](todo-nl/index.ts): free-text commands mapped onto a real app's machine events through an explicit `agent.decide` loop, with [`todo-nl/imperative.ts`](todo-nl/imperative.ts) as the deliberate library-free A/B pair.
- [`joke/index.ts`](joke/index.ts): a minimal streaming text workflow.
- [`triage/index.ts`](triage/index.ts): structured-output support ticket triage.
- [`email-drafter/agent-logic.ts`](email-drafter/agent-logic.ts): a typed email workflow built from independently testable requests.
- [`email-drafter-inspector/index.ts`](email-drafter-inspector/index.ts): the email-drafter machine run as one live `createActor` session wired to `createInspector`, so the whole flow is visible in the Stately Inspector.
- [`guardrails/index.ts`](guardrails/index.ts): input and output guardrails as explicit gate states that refuse out-of-scope questions and verify answers before returning them.
- [`context-compaction/index.ts`](context-compaction/index.ts): a self-managing chat loop whose `compacting` state folds stale messages into a running summary once history exceeds a threshold.
- [`described-workflow/index.ts`](described-workflow/index.ts): a plain `createMachine` whose writing states send their described prompts directly and whose idle judging gate is interpreted through `runAgent({ getRequests })`.
- [`plain-xstate/index.ts`](plain-xstate/index.ts): a normal XState v6 `setup(...)` machine with zero knowledge of the library, adopted as an agent through `getAcceptedEvents` and `resolveDecision`.
- [`json-agent/index.ts`](json-agent/index.ts): `setupAgent.fromConfig(...)` lowering a support-ticket workflow authored as a real `.json` file.
- [`preset-machine/index.ts`](preset-machine/index.ts): `createParallelMachine` from `@statelyai/agent/machines`, running two review branches as regions of one parallel state and joining by branch name.
- [`retrofit/index.ts`](retrofit/index.ts): a hand-rolled `while`-loop agent converted into a machine one shippable step at a time.
- [`machine-as-tool/index.ts`](machine-as-tool/index.ts): a whole agent machine embedded inside one tool call of a host harness, bridged by a JSON-safe snapshot handle.
- [`chat-with-pdf/index.ts`](chat-with-pdf/index.ts): a chat-with-PDF quiz recipe with the question sequencing lifted out of the instructions and into the machine.

## Human in the loop and durability

- [`human-in-the-loop/index.ts`](human-in-the-loop/index.ts): draft, idle review with typed `meta.interaction`, then approve or redraft, with a JSON snapshot round-trip.
- [`long-running-onboarding/index.ts`](long-running-onboarding/index.ts): an onboarding coordinator with two idle states, JSON snapshot resume across days, and delegated IT provisioning.
- [`review-tool-calls/index.ts`](review-tool-calls/index.ts): an idle state gating a proposed tool call so the human can approve it, edit its arguments, or reject it with feedback.
- [`customer-support/index.ts`](customer-support/index.ts): intent routing plus safe question answering, with sensitive actions gated behind an idle `confirming` state.
- [`time-travel/index.ts`](time-travel/index.ts): checkpointing each settle, rewinding to a past checkpoint, and forking a divergent branch while the main branch stays unchanged.
- [`crash-recovery/index.ts`](crash-recovery/index.ts): events-only resume, where a crash mid-request recovers from `runAgent({ events })` alone and the in-flight request re-executes idempotently.
- [`snapshot-migration/index.ts`](snapshot-migration/index.ts): resuming a paused run after the machine was redeployed, where the machine's own `version` stamp makes a stale snapshot throw with `from`/`to` and `migrateSnapshot` adapts it at the boundary.
- [`session-actor/index.ts`](session-actor/index.ts): `createAgentActor` session mode, one live actor across turns on a single replayable log with cumulative usage.
- [`file-snapshot-store/index.ts`](file-snapshot-store/index.ts): durable checkpoints in a file-backed snapshot store, where each idle settle writes JSON to disk.

## Agent patterns

- [`supervisor/index.ts`](supervisor/index.ts): a routing request's structured output handing off to a format-specific worker.
- [`hierarchical-teams/index.ts`](hierarchical-teams/index.ts): two-level supervisors, where a research team loops workers under a coordinator that can send back one bounded revision round.
- [`trading-team/index.ts`](trading-team/index.ts): parallel analysts, a bounded bull and bear debate, a trader proposal, and a risk review that can force one revision.
- [`swarm-handoff/index.ts`](swarm-handoff/index.ts): a persistent multi-agent network handing off across turns.
- [`plan-and-execute/index.ts`](plan-and-execute/index.ts): planner structured output with execution states iterating the plan, keeping the ReWOO evidence-map idea.
- [`subflows/index.ts`](subflows/index.ts): agent machines invoking other agent machines as XState child actors, each keeping its own executor binding.
- [`fan-out/index.ts`](fan-out/index.ts): dynamic runtime fan-out, where a planner produces N subtopics, the machine spawns one live child branch each, and a reducer composes the results.
- [`rag/index.ts`](rag/index.ts): retrieval as a typed plain actor feeding a grounded answer, with conversational memory in context.
- [`corrective-rag/index.ts`](corrective-rag/index.ts): corrective RAG as explicit states, grading documents and branching into query rewrite and a separate sample-index fallback.
- [`adaptive-rag/index.ts`](adaptive-rag/index.ts): adaptive RAG routing between a local corpus and sample web index, then grading, bounded rewriting, and verifying the generation.
- [`deep-research/index.ts`](deep-research/index.ts): planning complementary searches, one dynamically spawned researcher per query, coverage reflection, and a sourced report.
- [`reflection-writer/index.ts`](reflection-writer/index.ts): a generate and critique loop with a typed `maxRevisions` bound and a structured early exit.
- [`code-assistant/index.ts`](code-assistant/index.ts): self-correcting code generation with sandboxed `node:vm` checks and a bounded reflect-and-regenerate branch.
- [`lats/index.ts`](lats/index.ts): Language Agent Tree Search as bounded selection, candidate expansion, and reflection scoring until solved or out of budget.
- [`react-agent/index.ts`](react-agent/index.ts): a ReAct loop made explicit, where one request per iteration returns a call-a-tool-or-answer union under a step-budget guard.
- [`sql-agent/index.ts`](sql-agent/index.ts): query generation, database execution, and answer synthesis as separate typed states.
- [`tool-calling/index.ts`](tool-calling/index.ts): the model selecting a tool by structured output, typed tool actors executing it, and progress reported via `onTransition`.
- [`debate-sub-agents/index.ts`](debate-sub-agents/index.ts): a facilitator scheduling two event-based debater sub-agents.
- [`simulated-user-evaluation/index.ts`](simulated-user-evaluation/index.ts): a bounded chatbot and simulated-user loop followed by an independent transcript judge.

## Hosts and executors

- [`ai-sdk-host/index.ts`](ai-sdk-host/index.ts): the Vercel AI SDK adapter supplying host actors.
- [`ai-sdk-sub-agents/index.ts`](ai-sdk-sub-agents/index.ts): Vercel AI SDK `ToolLoopAgent` workers exposed as host-owned tools.
- [`ai-sdk-game-host/index.ts`](ai-sdk-game-host/index.ts): the canonical step-path wiring over the Vercel AI SDK, executing and folding one effect per frontier.
- [`openai-sdk-host/index.ts`](openai-sdk-host/index.ts): the executor contract implemented directly against the raw `openai` package.
- [`anthropic-sdk-host/index.ts`](anthropic-sdk-host/index.ts): the executor contract implemented directly against the raw `@anthropic-ai/sdk` package.
- [`cloudflare-workers-ai-host/index.ts`](cloudflare-workers-ai-host/index.ts): a durable step-path host on Cloudflare Workers AI that persists only the event-log journal and resumes by `replay`.
- [`cloudflare-agent-host/index.ts`](cloudflare-agent-host/index.ts): a Cloudflare Agents host persisting XState snapshots in Durable Object state.
- [`langchain-host/index.ts`](langchain-host/index.ts): LangChain both directions, wrapping any `BaseChatModel` into the executor contract and handing a LangChain agent loop the email-drafter machine as two tools.

## AI SDK workflow patterns

- [`ai-sdk-marketing-chain/index.ts`](ai-sdk-marketing-chain/index.ts): the Vercel AI SDK sequential chain as an explicit XState machine.
- [`ai-sdk-routing/index.ts`](ai-sdk-routing/index.ts): the Vercel AI SDK routing pattern as an explicit XState machine.
- [`ai-sdk-parallel-review/index.ts`](ai-sdk-parallel-review/index.ts): the Vercel AI SDK parallel review pattern as an explicit XState machine.
- [`ai-sdk-orchestrator-worker/index.ts`](ai-sdk-orchestrator-worker/index.ts): the Vercel AI SDK orchestrator-worker pattern as an explicit XState machine.
- [`ai-sdk-evaluator-optimizer/index.ts`](ai-sdk-evaluator-optimizer/index.ts): the Vercel AI SDK evaluator-optimizer pattern as an explicit XState machine.

## Framework hosts

The same agent machine served from real app frameworks, in both modes: controlled (`runAgent` per request, snapshot persisted between requests) and uncontrolled (`provideExecutors` plus `createActor`, the app owns the actor).

- [`express-host/index.ts`](express-host/index.ts): controlled mode over HTTP, where an Express route runs or resumes an agent and an idle settle plus persisted snapshot spans requests.
- [`hono-host/index.ts`](hono-host/index.ts): the express-host shape in Hono, plus a streaming endpoint piping `onChunk` into the response body.
- [`next-host/app/api/agent/route.ts`](next-host/app/api/agent/route.ts): Next.js App Router route handlers running an agent across the stateless request boundary.
- [`tanstack-start-host/index.ts`](tanstack-start-host/index.ts): TanStack Start server functions invoking `runAgent`.
- [`react-uncontrolled/index.tsx`](react-uncontrolled/index.tsx): uncontrolled mode in React, where the actor drives itself and the UI observes snapshots and sends user events.
- [`flue-host/index.ts`](flue-host/index.ts): Flue 2 two ways, with [`machine-owned.ts`](flue-host/machine-owned.ts) giving the agent bridge tools over `runAgent` and [`flue-owned.ts`](flue-host/flue-owned.ts) replacing a string step variable with a small steps machine.
- [`eve-host/agent.ts`](eve-host/agent.ts): the same start and resume tool bridge in Eve's folder convention, where the machine owns draft legality and the Eve agent converses.
- [`mastra-host/index.ts`](mastra-host/index.ts): the same bridge on the real `@mastra/core`, deriving the resume event from the machine's own `meta.interaction`.

## Streaming and transport

- [`ai-sdk-ui-stream/index.ts`](ai-sdk-ui-stream/index.ts): bridging a run to the Vercel AI SDK UI message stream behind a chat route handler a `useChat` client consumes unchanged.
- [`tanstack-ai-stream/index.ts`](tanstack-ai-stream/index.ts): a TanStack Start route bridging `runAgent`'s seams to TanStack AI's AG-UI wire protocol over SSE.
- [`sse-transport/index.ts`](sse-transport/index.ts): relaying provider stream chunks over SSE.
- [`parallel-streams/index.ts`](parallel-streams/index.ts): parallel worker streams over a side channel.

## Evals and observability

- [`verification/index.ts`](verification/index.ts): the whole keyless verification suite over a refund-approval machine, where `canReach` proves an over-limit payout without human approval is unreachable rather than merely discouraged.
- [`braintrust-evals/index.ts`](braintrust-evals/index.ts): a Braintrust `Eval()` over the unmodified email-drafter machine, scoring output, state path, trajectory, and usage, keyless and offline by default.
- [`seam-scoring/index.ts`](seam-scoring/index.ts): `runSeam` scoring one model call of the unmodified email-drafter machine while every other request is served from the call plan, comparing a good and a bad candidate for that call in a single table.
- [`langsmith-otel/index.ts`](langsmith-otel/index.ts): tracing a run to LangSmith over OpenTelemetry with a real OTLP exporter, printing the span tree when run keyless.

See [Evals](../docs/evals.md) for scoring runs, and [Observability](../docs/observability.md) for the trace stream.

## Framework comparison map

These map LangGraph, Burr, and CrewAI Flow patterns onto XState. The dedicated per-framework ports were consolidated into the pattern examples above.

- Supervisor routing and handoff: [`supervisor`](supervisor/index.ts), [`hierarchical-teams`](hierarchical-teams/index.ts), [`trading-team`](trading-team/index.ts), [`swarm-handoff`](swarm-handoff/index.ts)
- Planning and subgraphs: [`plan-and-execute`](plan-and-execute/index.ts), [`subflows`](subflows/index.ts), [`fan-out`](fan-out/index.ts)
- Retrieval: [`rag`](rag/index.ts), [`corrective-rag`](corrective-rag/index.ts), [`adaptive-rag`](adaptive-rag/index.ts), [`deep-research`](deep-research/index.ts)
- Reflection and self-correction: [`reflection-writer`](reflection-writer/index.ts), [`code-assistant`](code-assistant/index.ts), [`lats`](lats/index.ts), [`simulated-user-evaluation`](simulated-user-evaluation/index.ts)
- Tools and SQL: [`tool-calling`](tool-calling/index.ts), [`react-agent`](react-agent/index.ts), [`sql-agent`](sql-agent/index.ts)
- Human in the loop: [`human-in-the-loop`](human-in-the-loop/index.ts), [`customer-support`](customer-support/index.ts), [`review-tool-calls`](review-tool-calls/index.ts), [`time-travel`](time-travel/index.ts), [`long-running-onboarding`](long-running-onboarding/index.ts)
- Streaming: [`parallel-streams`](parallel-streams/index.ts), [`sse-transport`](sse-transport/index.ts)
- AI SDK pattern set: [`ai-sdk-orchestrator-worker`](ai-sdk-orchestrator-worker/index.ts), [`ai-sdk-parallel-review`](ai-sdk-parallel-review/index.ts), [`ai-sdk-routing`](ai-sdk-routing/index.ts), [`ai-sdk-evaluator-optimizer`](ai-sdk-evaluator-optimizer/index.ts), [`ai-sdk-marketing-chain`](ai-sdk-marketing-chain/index.ts)

<!-- setupAgent config keys and decision authoring from src/setup-agent.ts and src/decision.ts -->

New examples should use `createTextLogic(...)` for reusable LLM work and `setupAgent({ schemas, actors, requests })` for schema-first machine authoring. Decisions are authored inline in states via `src: 'agent.decide'` (state-local); to reuse one across states, share the _input builder_ function (a `({ context }) => ({ model, system, prompt, allowedEvents })` fn), not an actor. There is no `decisions:` key on `setupAgent`.
