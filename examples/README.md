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
- [river-crossing](river-crossing): the machine is ground truth; guards reject the illegal crossings the model proposes
- [todo-nl](todo-nl): one free-text command becomes a bounded sequence of typed events via an explicit decide loop
- [context-compaction](context-compaction): an explicit `compacting` state, entered when the window overflows
- [chat-with-pdf](chat-with-pdf): one question per state entry, and a refresh guard instead of "after 3-4 questions"
- [game-agent](game-agent): rock-paper-scissors where the event log saved in context is the agent's only memory
- [game-loop-agent](game-loop-agent): an invoked agent that receives pushed events and can act only on its own turn
- [generate-and-repair](generate-and-repair): three candidates fanned out as concurrent invokes, judged by the host's own parser, with a repair round the machine caps explicitly

## Human in the loop

Every pause here is a first-class idle state with typed `meta.interaction`, so
it survives a snapshot round-trip instead of living in a closure.

- [human-in-the-loop](human-in-the-loop): the base shape — an idle review state, a `REJECT`-with-feedback redraft loop bounded by a counter, and a real JSON round-trip
- [review-tool-calls](review-tool-calls): who owns the tool loop — the machine gates each proposed call behind `APPROVE`/`EDIT`/`REJECT`, or the AI SDK runs the whole loop under `maxSteps` and the machine only appends the messages it returns
- [customer-support](customer-support): a classify request routes safe questions past the gate and sensitive actions into it
- [sql-agent](sql-agent): the model plans the query, a human approves, and only then does the engine run it
- [long-running-onboarding](long-running-onboarding): pauses measured in days, with a bounded resend loop and an escalation path off every wait
- [machine-as-tool](machine-as-tool): the whole machine behind one tool call, where the handle _is_ the persisted snapshot

## Parallel and multi-agent

- [hierarchical-teams](hierarchical-teams): a coordinator over two child machines, each with its own budget
- [swarm-handoff](swarm-handoff): the model chooses `HANDOFF` under a guard, and the active agent survives a snapshot round-trip
- [deep-research](deep-research): dynamic fan-out — a researcher spawned per query, results reduced as they land
- [parallel-streams](parallel-streams): two regions streaming at once, each chunk tagged with the request it came from
- [just-one](just-one): isolated parallel regions whose inputs are fixed before any sibling settles; the duplicate-cancelling rule is a pure function, not an instruction
- [chameleon](chameleon): hidden information enforced by request input shaping — the chameleon's request provably never carries the secret word

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
- **Mock executors route on `request.name`** (the `setupAgent({ requests })`
  key), or use name-keyed `createScriptedExecutors`. Never on a prompt
  substring, a call index, a positional array, or `request.model` — those pass
  while silently exercising the wrong request.
- **Context is replay-stable**: no `Date.now()`, `Math.random()`, or
  `randomUUID()` in context, and no module-level mutable state. Pass stores and
  executors in, or use a factory function.
- **Derived strings are computed in `output` or the host**, not stored in
  context. Boolean mirrors of final states and sentinel values (`""`, `-1`) are
  replaced by states, or by `output` derived from `snapshot.matches`.
- **Event names are facts or commands** from the human or host. Choices the
  model makes go through `agent.decide` and are filtered by guards.
- **Sibling imports are allowed** — an example may import another example's
  machine — but there is no shared test harness. Each example's test stands on
  its own.
