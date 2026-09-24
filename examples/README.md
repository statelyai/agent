# Examples

These examples use one XState machine artifact across different model SDKs and hosts.

Sections group examples by **what the machine proves**, not by which provider
they happen to call.

<!-- curated example catalog derived from examples/*/metadata.json and examples/index.ts -->

## Start here

- [email-drafter](email-drafter): typed requests, revision, approval, and sending
- [plain-xstate](plain-xstate): an ordinary XState machine that knows nothing about the agent library
- [retrofit](retrofit): the same agent as a `while(true)` loop and as a machine, refactored step by step
- [json-agent](json-agent): the whole workflow authored as a `.json` file and lowered to the same machine
- [triage](triage): structured model output, with one retry when the draft fails

## Control flow a loop can't express

Each entry names the construct that makes the behavior structural rather than a
convention in a prompt.

- [twenty-questions](twenty-questions): a guard makes the final turn a `GUESS` — the model cannot spend it on a question
- [guardrails](guardrails): input and output checks as separate states; an unsupported answer is flagged, not returned
- [joke](joke): the model itself decides whether to loop again, through `agent.decide` under a guard
- [reflection-writer](reflection-writer): a revision budget in context, compared against a constant in a guard
- [code-assistant](code-assistant): a retry budget around code that really runs and really fails
- [corrective-rag](corrective-rag): a grade-then-branch choice state picks answering or a rewritten fallback lookup
- [plan-and-execute](plan-and-execute): a step budget that can be exhausted — the run ends in `failed` instead of answering from a half-executed plan
- [river-crossing](river-crossing): the machine is ground truth and solves itself — `REQUEST_PLAN` traverses it with `xstate/graph` and hands back the shortest legal route, and guards reject any crossing the model proposes off it
- [route-replanning](route-replanning): a plan is a prediction — the machine plans the whole route, drives it a leg at a time without recomputing, and replans from where it stands when a road turns out to be shut
- [todo-nl](todo-nl): one free-text command becomes a bounded sequence of typed events via an explicit decide loop
- [context-compaction](context-compaction): an explicit `compacting` state, entered when the window overflows
- [chat-with-pdf](chat-with-pdf): one question per state entry, and a refresh guard instead of "after 3-4 questions"
- [game-agent](game-agent): rock-paper-scissors where the event log saved in context is the agent's only memory
- [game-loop-agent](game-loop-agent): an invoked agent that receives pushed events and can act only on its own turn
- [generate-and-repair](generate-and-repair): three candidates fanned out as concurrent invokes, judged by the host's own parser, with a repair round the machine caps explicitly
- [adaptive-rag](adaptive-rag): a router picks the index, then choice states check `MAX_REWRITES` and `MAX_REGENERATIONS` on both the rewrite loop and the regenerate loop, where LangGraph relies on `recursion_limit`
- [agentic-rag](agentic-rag): the model picks `RETRIEVE` or `ANSWER` through `agent.decide`, and a guard rejects `RETRIEVE` once `MAX_RETRIEVALS` is spent, so an answer forced by the budget lands in `failed`
- [reflexion](reflexion): the critique drives real searches and each revision must cite what came back; citations to passages the run never retrieved are dropped, and a revision budget caps the loop
- [tree-of-thoughts](tree-of-thoughts): a hand-written scorer rechecks every proposed Game of 24 step and rejects any that uses a number not on the table; a beam capped at `BEAM_SIZE` and `MAX_DEPTH` ends in `failed` when no line reaches 24
- [self-discover](self-discover): a choice state requires 1 to `MAX_SELECTED_MODULES` reasoning modules and retries selection once with feedback before failing, a check the LangGraph chain leaves to trust
- [prompt-chaining](prompt-chaining): the punchline gate is a choice state over a pure check, and a failed check regenerates at most twice before landing in `failed` instead of ending silently
- [data-enrichment](data-enrichment): a choice state, not the model, decides the record is complete; gap searches and reviewer rejections share one `MAX_LOOPS` budget that ends in `failed` with the partial record
- [tnt-llm](tnt-llm): one summary child spawned per document, then a batch index in context drives generate, update per batch, and review through choice states, with a category cap
- [tool-retrieval](tool-retrieval): a guard lets `agent.decide` call only the tools the selector surfaced, with tool-call and reselection budgets forcing an answer
- [model-fallback](model-fallback): a validator actor plus a choice state send a rejected cheap-model tool call to a stronger model exactly once (`MAX_FALLBACKS`), then `failed`
- [project-planner](project-planner): the model only proposes tasks; the machine checks the dependency graph (with a repair budget) and computes the critical-path schedule, and a choice state replans against the deadline until `MAX_REPLANS`

## Human in the loop

Every pause here is a first-class idle state with typed `meta.interaction`, so
it survives a snapshot round-trip instead of living in a closure.

- [human-in-the-loop](human-in-the-loop): the base shape — an idle review state, a `REJECT`-with-feedback redraft loop bounded by a counter, and a real JSON round-trip
- [review-tool-calls](review-tool-calls): who owns the tool loop — the machine gates each proposed call behind `APPROVE`/`EDIT`/`REJECT`, or the AI SDK runs the whole loop under `maxSteps` and the machine only appends the messages it returns
- [customer-support](customer-support): a classify request routes safe questions past the gate and sensitive actions into it
- [sql-agent](sql-agent): the model plans the query, a human approves, and only then does the engine run it
- [long-running-onboarding](long-running-onboarding): pauses measured in days, with a bounded resend loop and an escalation path off every wait
- [machine-as-tool](machine-as-tool): the whole machine behind one tool call, where the handle _is_ the persisted snapshot
- [info-gathering](info-gathering): a choice state checks the four requirement slots itself (the model only extracts), forces one confirmation turn, and ends in `failed` after `MAX_TURNS` answers
- [long-term-memory](long-term-memory): the memory store is machine input and output, recall and a capped save are their own states, and a second run started from the first run's output remembers
- [feynman-tutor](feynman-tutor): an idle explain-back state per checkpoint; a choice state re-teaches below `PASS_SCORE` while a per-checkpoint `MAX_RETEACHES` budget lasts, then records the checkpoint failed and moves on

## Parallel and multi-agent

- [hierarchical-teams](hierarchical-teams): a coordinator over two child machines, each with its own budget
- [swarm-handoff](swarm-handoff): the model chooses `HANDOFF` under a guard, and the active agent survives a snapshot round-trip
- [deep-research](deep-research): dynamic fan-out — a researcher spawned per query, results reduced as they land
- [parallel-streams](parallel-streams): two regions streaming at once, each chunk tagged with the request it came from
- [just-one](just-one): isolated parallel regions whose inputs are fixed before any sibling settles; the duplicate-cancelling rule is a pure function, not an instruction
- [chameleon](chameleon): hidden information enforced by request input shaping — the chameleon's request provably never carries the secret word
- [agent-supervisor](agent-supervisor): a flat supervisor routes through `agent.decide` under guards: each worker is capped at two reports, `FINISH` is illegal until one lands, and a turn budget ends in `failed`
- [map-reduce](map-reduce): LangGraph's `Send` fan-out as one spawned `writeJoke` child per subject, reduced as they land, with a capped width and a choice state that rejects an out-of-range judge index
- [llm-compiler](llm-compiler): each task's dependencies are the `$N` references in its args; a choice state rejects references to later or missing tasks before anything runs, each wave of ready tasks is spawned together, and a task's inputs are filled in only after the tasks it references finish
- [storm-writer](storm-writer): one interview child machine spawned per editor with a turn cap, transcripts reduced as they land; editor, turn and section overflow is dropped and counted against exported constants
- [multi-agent-debate](multi-agent-debate): turn order and round count are machine edges, with a `MAX_ROUNDS` ceiling in the input schema; no speaker can end the debate or speak out of turn

## Persistence and recovery

- [crash-recovery](crash-recovery): events-only recovery by folding the log; no snapshot is persisted
- [snapshot-migration](snapshot-migration): a run paused before a deploy and resumed after it, through XState's native `version`/`migrate` contract
- [portable-xstate-loop](portable-xstate-loop): the durable transition/effect loop written by hand, with no Agent runner
- [file-snapshot-store](file-snapshot-store): the same machine two ways — persisted to a JSON file between processes, and kept alive in one long-lived `createActor` that persists nothing

## Hosts and adapters

These are **not** machine showcases. They hold the machine constant and vary
what surrounds it, to show the control flow is portable. Most need a provider
key or a specific runtime, so they set `manual: true` and are not exported from
`index.ts`.

- [ai-sdk-host](ai-sdk-host): Vercel AI SDK tool calls mapped to legal machine events for a narrated combat turn
- [ai-sdk-ui-stream](ai-sdk-ui-stream): the AI SDK v7 UI message stream protocol — a text lane per request plus live machine state, to an unmodified `useChat`
- [tanstack-ai-stream](tanstack-ai-stream): the same run as AG-UI server-sent events
- [anthropic-sdk-host](anthropic-sdk-host), [openai-sdk-host](openai-sdk-host): the executor contract against the raw provider APIs, with no AI SDK in between
- [langchain-host](langchain-host), [mastra-host](mastra-host), [flue-host](flue-host): coexistence with a framework — the framework makes the model calls, the machine owns legality
- [cloudflare-agent-host](cloudflare-agent-host): a Durable Object whose SQLite event log is the source of truth
- [cloudflare-workers-ai-host](cloudflare-workers-ai-host): a provider with no native tool calling, so the legal events are serialized into the prompt
- [next-host](next-host): controlled mode across a stateless Next route handler

## Evals and verification

- [verification](verification): `canReach` proves a violation state unreachable across every branch, without one model call
- [braintrust-evals](braintrust-evals): evals over typed output, transition trajectories, named request calls, and usage
- [ai-sdk-evaluator-optimizer](ai-sdk-evaluator-optimizer): the evaluator-optimizer loop as explicit states, with a strict critic gating the exit
- [chatbot-simulation-eval](chatbot-simulation-eval): a simulated customer and the bot under test alternate under a `MAX_EXCHANGES` choice guard, the bot's request input provably omits the persona, and the judge runs inside the machine
- [essay-grader](essay-grader): three choice states over exported score thresholds stop grading at the first weak pass, and the result names the stage it stopped after

## Statechart policies

- [consensus-review](consensus-review): two-of-three reviewer approval, abstentions, and human escalation
- [booking-compensation](booking-compensation): approval before effects, compensation, and uncertain-outcome reconciliation
- [deadline-escalation](deadline-escalation): scheduler-driven approval deadlines and stale-event rejection; `manual: true` because it needs a two-phase CLI and a trusted host clock on top of the provider key

All three run against a real model with `OPENAI_API_KEY=... pnpm tsx examples/<name>/index.ts`; their tests script the model by request name through the AI SDK's mock model. See [Statechart policy examples](../docs/statechart-policy-examples.md) for sources, tests, and host contracts.

## Conventions

Every example follows these. A new example that breaks one is probably wrong.

- **Interaction metadata** uses the exported `interactionMetaSchema` as the
  machine's `meta` schema, and is read back with `getInteraction(snapshot)` —
  never a hand-rolled copy of either.
- **Branching is a `type: "choice"` state with guards**, not an `if` inside an
  `onDone` handler or a helper function. A branch has to be in the machine to
  be inspectable.
- **Every loop is bounded** by a counter in context compared against an
  exported constant in a guard.
- **Exhausting a budget lands in a `failed` final state.** Degrading to `done`
  with an empty or partial output is a bug, not graceful handling.
- **Every `invoke` has an `onError`.** The `invoke-without-on-error` lint code
  must stay clean.
- **Tests mock the model with `examples/mock-model.ts`**: the AI SDK's
  `MockLanguageModelV3` behind the real `createAiSdkExecutors` adapter, with
  answers keyed by request name (the `setupAgent({ requests })` key). The
  helper is repo-internal and not published. A hand-written mock executor
  routes on `request.name` too. Never on a prompt substring, a call index, a
  positional array, or `request.model` — those pass while silently exercising
  the wrong request.
- **Context is replay-stable**: no `Date.now()`, `Math.random()`, or
  `randomUUID()` in context, and no module-level mutable state. Pass stores and
  executors in, or use a factory function.
- **Derived strings are computed in `output` or the host**, not stored in
  context. Boolean mirrors of final states and sentinel values (`""`, `-1`) are
  replaced by states, or by `output` derived from `snapshot.matches`.
- **Event names are facts or commands** from the human or host. Choices the
  model makes go through `agent.decide` and are filtered by guards.
- **Sibling imports are allowed** — an example may import another example's
  machine — but there is no shared test harness beyond the
  `examples/mock-model.ts` model double. Each example's test stands on its own.
