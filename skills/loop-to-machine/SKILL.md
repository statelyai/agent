---
name: loop-to-machine
description: Convert existing agent code (a while-loop around a model, a tool loop, a tool-call scheduler, ad-hoc if/else control flow) into an XState v6 state machine with @statelyai/agent, and prove with a parity report that it behaves like the code it replaces. Use when asked to "turn this agent into a state machine", "port my loop to xstate", "make this a statechart", "refactor this agent into a machine", or "split environment and policy" for code that already runs.
---

# Convert agent code to a machine

You replace the control flow of working agent code with a machine, and show where it behaves like the old code and where it differs on purpose. Model calls, tools, and retry code move across unchanged.

```
inventory → pin the baseline → environment → (policy) → runner → proofs → parity → hand back
```

This is step 1 of 4. Next: `add-traces`, then `add-evals`, then `improve-machine`. To author a machine with no existing code, use `generate-machine`. Recording, replay, and the full parity test code are in [reference.md](reference.md).

## Hard rules

- **Pin the baseline before you change anything.** The parity test runs against the old code, which stays in the repo, untouched, until a person deletes it. When the old code cannot run, the baseline is a written behavioral spec (see "No model in the loop").
- **Never promise "behaves exactly like".** Promise what the parity evidence shows: equivalent effects on these scenarios, every difference labeled.
- **Never copy a rule break.** Where the old code broke a rule, the machine blocks it. That difference is `intended`, not a regression.
- **Rules are code, not prompt text.** A prompt-only rule becomes a guard; the prompt line stays only as context.
- **Business rules belong to people.** Ambiguous rule (which threshold, which order)? Ask; never pick silently.
- **Port call shapes unchanged first.** An SDK tool call stays a text request with the same tools. Changing it (to `agent.decide` or `agent.act`) is a separate step with its own `INTENDED` divergences.

## 0. Before you write code


- Text requests need exactly one non-empty `prompt` or `messages`. `setupAgent` throws `invalid-request` when both are omitted; a request that resolves neither or both at run time fails validation with schema issues.
- Actors: `createAsyncLogic<Output, Input>({ run })` from `xstate` (no `fromPromise` in v6); without the generics `onDone`'s `output` is untyped.
- `onIdle` return events need `as const` on `type`, or the union does not narrow.
- In `onError`, the error is `event.error`; there is no `error` argument.
- Context, input, events, outputs: JSON only. No `Date`, `Error`, `Map`, class instances, functions; store ISO strings and `String(error)`.
- Every executor slot is optional in the type; assert the ones you call.
- `request.metadata.facts` is `unknown`; parse it with the exported facts schema.
- A `type: "choice"` state has no `enq` or actions; when routing must emit, use `always` on a normal state.
- `compareRuns` scenarios reserve `expected: string` for the outcome; name other expectations differently.
- `explorePaths` `errors`: one error per src, unless your installed type accepts an array per src; otherwise drive repeated failures from a context counter.

## 1. Inventory the code

Read the loop and fill this table before writing anything. Each row maps to a machine element.

| In the code | Becomes |
| --- | --- |
| A tool with a side effect someone must gate (refund, send) | An actor invoked by one state, entered only through a guarded transition |
| A read-only tool (search, lookup) | An actor the machine invokes, or a tool on a text request |
| A rule: an `if`, a prompt line, a check after the fact | A guard on the transition it protects |
| A model call that produces content | A text request in `setupAgent({ requests })`, invoked by one state |
| One SDK tool call that picks the action and carries its content (`send_email({ … })`) | A text request with those tools, then guards on the returned call: exactly one, offered, schema-valid. Those guards check shape only: a tool that still has `execute` runs inside the SDK before the request returns, so the unchanged-shape port keeps the old timing. A side effect that needs approval either loses its `execute` (the call comes back unexecuted; a state invokes the real work after the verdict) or moves to the decision step later. `agent.decide` would hide your tool names and descriptions |
| N tool calls per model turn, each needing approval | First port: the request returns the calls; a state holds them in context and waits for a verdict per call. Later step: `agent.act` ([docs/act.md](../../docs/act.md)), each call an event the state queues |
| A persisted "always allow" rule | Data loaded into input or context, read by a guard. Saving a rule is a recorded effect |
| A tool the browser runs (no `execute`) | The request ends with the tool calls; an idle state waits for `TOOL_RESULTS` |
| A point where the model picks what to do | A decision state: `agent.decide`, usually a closed choice |
| A check on model output, then retry or repair | A checking actor or guard, and a `choice` state routing to repair, next candidate, or a failure final |
| Provider retry/backoff around the SDK call | Stays in the executor, unchanged |
| Context overflow caught → compact → retry | A compaction request state, entered from the call's `onError` on an overflow error, with a retry cap |
| Recursive re-entry (`this.run()` inside the loop) | A transition back to the first state, under the recursion's cap (or a new one, `intended`) |
| A value pulled out of the input | Code when the format is fixed; a text request when not |
| A step every correct run takes in order | A state the machine enters itself |
| A person in the loop (`await approve()`, a returned `pending`, an ask-a-person tool) | An idle state with `meta.interaction` and `onIdle`, or an invoked wait actor (§5) |
| `AbortSignal` or a cancel method | `runAgent`'s `signal`, or a `CANCEL` event (§5) |
| Hooks or bus emissions the UI depends on | `enq.emit(...)` (declared under `emitted`) or `onTransition`, same payloads |
| Message history in a class field | Context when a guard or prompt reads it; else host-owned, passed as `messages`. Write down which |
| A streaming iterator | The `streamText` executor keeps it and pipes to the old consumer |
| Mutable state on the class instance | JSON context fields, or host state passed as input |
| A cap on a loop the machine keeps / removed | A `choice` state against an exported constant / nothing, with the reason recorded |
| A class-shaped runtime (`run`/`continue`/`abort`/`restore`/`snapshot`) | A subclass overriding the loop methods to call `runAgent`, inheriting the rest. The conversation may stay host-owned in the first port; a persisted snapshot then cannot resume alone, and moving it into context is a later labeled step |
| Each distinct return | A final state |
| A terminal tool with a side effect (`escalate`) | A state that invokes it, then the final; `onError` to a `failed` final |

List the rules as a numbered list in your notes. Every one must end as a guard, a state ordering, or a written reason it was dropped.

A loop with no decision point (generate-validate-repair, a tool loop, a scheduler) is still worth converting: caps, rules, and failure paths become explicit and provable. Skip step 4 and the decision parts of step 5.

## 2. Pin the baseline

The parity test exists before the machine does.

1. **Scenarios.** Reuse the code's tests, fixtures, or benchmarks: an `id` each and, where known, the `expected` outcome. If none exist, draft 6–10 covering every terminal and rule; ask the user to confirm them.
2. **Deterministic stand-in models.** The code's mocks, or a function from the request (prompt or `name`) to a fixed answer ([`examples/mock-model.ts`](https://github.com/statelyai/agent/blob/next/examples/mock-model.ts), repo only). Two: one follows the rules, one breaks them. A seeded model seeds from the scenario id, fresh per run.
3. **Ground truth.** Outcomes and effects from the world, not the agent's report. `effects` holds **every write the world records**: refunds, and also approvals, verifications, questions asked, escalations. Model-written text: compare count or presence. Violations come from the world, or a plain function over the effects.
4. **A baseline with no function to call.** Loop inline in a framework handler: call the handler with stand-in model and storage. Do not extract the loop first.
5. **Record golden runs.** AI SDK or `openai` client: wrap model and tools with `createRecorder` (`@statelyai/agent/testing`), run the old code per scenario and stand-in, save JSON fixtures. [reference.md](reference.md#recording-golden-runs). A custom model client has no recorder seam: skip recording; parity rests on the old suite (§7) or `compareRuns` with stand-ins.
6. **The harness check.** The old code on both sides of `compareRuns`, per stand-in: baseline equals candidate in every row; all `same` with the rule-following model, `regression` by design with the rule-breaker. [reference.md](reference.md#the-parity-harness).

### No model in the loop

This branch is for code with no model call at all (a tool scheduler, an approval queue), and for old code that cannot run (a class wired to a bus, no callable entry). A tool runner whose text request still picks tools has a model in the loop: keep the recorders and the replay check (§7) for its model and tool calls, and use only the spec baseline below where the old code cannot run.

- **Skip recorders only when nothing calls a model.** Then replay (§7) does not apply.
- **Baseline as spec.** When the old code cannot run, the baseline returns a pinned expectation per scenario: `baseline: async (s) => SPEC[s.id]`, with the outcome, effects, and violations a person confirmed from the old code and its docs, before the machine exists. Skip the harness check; the hand-back says the baseline is a spec, not a run.
- **Stand-ins become scripted worlds:** the proposed calls, the order approvals arrive in, which tool fails.

## 3. Author the environment

The environment is the machine: states, guards that encode the rules, side-effecting actors, an invariant sentinel. Use `setupAgent` (from `@statelyai/agent`) with zod schemas for `input`, `context`, `output`, and every event. Export the event schemas as one object for a later policy. A gated action (closed-choice `agent.decide`, guard in the transition) is in [reference.md](reference.md#a-gated-action).

- **Do the deterministic steps yourself.** Identity, lookup, ownership: states run in order. A model only answers what needs judgment.
- **Export the guards** as plain functions, and build the machine in a factory (`createDeskMachine({ refundIsLegal })`) so a test can pass a loosened guard.
- **Add an invariant sentinel** for the rule that must never break: a final state described `SENTINEL: …`, entered from an `always` on the side-effect state (`paying`); `always` runs before the invoke starts, so the effect never runs. The check is its own function, not the guard, so a loosened guard does not loosen it.
- **A person's step** is an idle state whose `meta.interaction` tells a host what to render: `{ label, events: { APPROVE: { label: "Approve" }, REJECT: { label: "Reject" } } }`, or `textEvent: { type: "CUSTOMER_REPLIED", field: "reply" }` for free text.
- **Actors are placeholders** in `setupAgent({ actors })`; pass the real ones with `runAgent(machine, { actors })`.
- **Final outputs carry the result** (`{ outcome, orderId, amount }`); the runner rebuilds the old return type from it and the world.
- **Declare `version`** (`version: "1"`). The structural hash cannot see transition functions; traces stamp this string.

## 4. A policy, only if the code already has one

Keep the decision in the environment as one `agent.decide`, with no policy machine, unless the old code has decision logic beyond one model call: a rule ladder, strategy heuristics, a cheap check before the model. `improve-machine` introduces a policy when traces show a rule worth adding. If the code has that logic, port it as a policy machine that answers the decision: [policy.md](policy.md).

## 5. The runner

Write `runMachine` with the old function's signature and result type, so callers and the parity test change one line.

- **The existing SDK call becomes the executor.** `generateText` (or `streamText`) in `executors`, as the old call: same model, system prompt, tools, options, retry code; return `{ result }`. Pass the conversation as `messages: ({ input }) => input.messages`.
- **A streaming route keeps its response, not its signature.** `createAiSdkExecutors().streamText` forwards text chunks only. Write the executor around the old call, pipe its stream to the old consumer, return the final messages as `{ result }`.
- `runAgent(machine, { input, executors, actors, onIdle })`. `onIdle` answers each idle state with the old code's call.
- `executors.decide` reads `request.options` (each `{ event }`) and `request.metadata?.facts`.
- JSON-safe input and events at the boundary: with a store, an unloggable value fails the run.
- Rebuild the old result from `result.output` and the world. A field with no meaning now keeps its type and a comment.

**Approvals off a message bus.** The rule: nothing else runs while the answer is awaited → idle state + `onIdle`. Other calls in flight, or answers arriving in any order → the run is never idle, so invoke a wait actor in the waiting state: `createCallbackLogic` that subscribes to the bus, sends `APPROVED`/`REJECTED` with the call id to its parent, and unsubscribes on exit. For N calls per batch (per-call approve/reject/always, a barrier before execute, cancel-all), use `createApprovalBatchMachine` from `@statelyai/agent/machines` if your installed version has it; otherwise a child machine per batch that sends status events to the parent, which releases it with an event once every call has a verdict.

**Host events mid-run** (cancel, abort, a user message while a request runs):

- Abort: `runAgent`'s `signal`. The run settles `{ status: "error", cause: "aborted" }`; the in-flight executor sees the signal.
- A cancel the machine handles (cleanup, a `cancelled` final): a `CANCEL` event on the parent state, sent by the host with `AgentRuntime.send(event)` if your installed version has it. Otherwise drive `createAgentRuntime` yourself and race `runtime.nextEvent()` against a host inbox. `nextEvent()` consumes the event it resolves with, so never call it again while an earlier call is still pending: keep the one pending `nextEvent()` promise across loop iterations, transition the host event when it wins, and keep racing the same pending promise until it resolves, or its event is lost.

## 6. Proofs that need no model

From `@statelyai/agent/testing` (example options in [reference.md](reference.md#proof-options)):

- `lintAgentMachine`: no errors.
- `canReach(machine, "<sentinel>", options)` returns `reachable: false` **and** `complete: true`, for each distinct input shape (with and without an order id lead to different paths; loop over them).
- `options.payloads(snapshot)` returns payload lists per event type, on both sides of every guard boundary (`0`, the threshold and one over, each producible amount and one over). Without it a closed choice explores only its own `payloads`, and `complete: true` proves nothing about boundaries. A person's free-text event needs one payload per branch.
- `outputs`: every output each actor can return; `errors`: each actor fails.
- **A loop** needs `options.dedupeBy`, or the search hits `maxDepth` with `complete: false`. Key on the state value plus the fields read at the loop head (counters, flags); drop fields that only change within one pass. A search over a few seconds: cut the key first. `outputs` are per src, not per call: for "fails twice, then succeeds", let the guard read a context counter.
- A `choice` or `always` state the machine passes through is reachable and listed in `reachedStates`, so it works as a sentinel.
- A loosened guard makes `canReach` true; test that too.
- Each normal final is reachable (the search is not vacuous).

Type options with `ExplorePathsOptions` and callback snapshots with `ExploreSnapshot` (`@statelyai/agent/testing`), not your app's `AnyMachineSnapshot`.

## 7. Parity

Switch the candidate to `runMachine`; run per stand-in (or against the spec). Code in [reference.md](reference.md#the-parity-harness).

- Every `regression` row: fix the machine, or, when the old behavior was wrong but broke no rule, ask the user. Differing outcomes: the answer may become `expected`. Differing effects only: list the row in a reviewed-differences map, exact difference asserted, with who accepted it. Never edit a scenario to make a row pass.
- **Run the old suite against the port**, the strongest evidence when the old code has tests: mock the old module (`vi.mock`) with a subclass whose loop methods call `runAgent`, and assert a canary counter the machine increments, so a passing suite proves the machine ran.
- Every `intended` row: check that its reason is a real rule. A candidate that fixed a rule break with the same outcome is `intended` too.
- With recordings, replay each against the machine (`createRecorder({ replay })`, `compareRecordings`): no key, no side effects, every divergence in `INTENDED` with who accepted it, including a guard that blocks a rule break. Semantics in [reference.md](reference.md#replay-equivalence).
- With no model in the loop, parity is the whole proof: the spec baseline plus §6. Say so.
- A live-model run, if a key exists, is one sample, not a guarantee.

## 8. Hand back

Report, in this order:

1. The files (environment, runner, tests, any policy); the old code untouched.
2. The rule list, each mapped to a guard, a state, or why it was dropped.
3. The parity table per stand-in model: `same / intended / regression`, one line per `intended` row with its reason. Say whether the baseline was a run or a spec.
4. The `canReach` results and the loosened-guard test.
5. The machine rendered: `describeMachine(machine)` output, and how to watch it live in the Stately inspector (pass `@statelyai/sdk`'s `inspector.inspect` as `runAgent`'s `inspect`; see [docs/observability.md](../../docs/observability.md)).
6. Anything you had to decide that the user should confirm, including where message history lives.
7. Next step: `add-traces`.
