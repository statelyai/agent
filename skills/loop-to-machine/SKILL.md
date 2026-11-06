---
name: loop-to-machine
description: Convert existing agent code (a while-loop around a model, a tool loop, a tool-call scheduler, ad-hoc if/else control flow) into an XState v6 state machine with @statelyai/agent, and prove with a parity report that it behaves like the code it replaces. Use when asked to "turn this agent into a state machine", "port my loop to xstate", "make this a statechart", "refactor this agent into a machine", or "split environment and policy" for code that already runs.
---

# Convert agent code to a machine

You replace the control flow of working agent code with a machine, and show where it behaves like the old code and where it differs on purpose. Model calls, tools, and retry code move across unchanged.

```
inventory → pin the baseline → environment → (policy) → runner → proofs → parity → hand back
```

## Default track: wrap first, carve per commit

For an async workflow (not a hand-rolled loop you are asked to replace wholesale), start here, and use the sections below for each carved phase.

1. **Step 0: wrap and record.** Move every side effect behind one `effects` object of async functions (the only edit to the old code). Then `wrapWorkflow({ id, effects, run: (input, effects) => old(input, effects) })` from `@statelyai/agent`. Pin the baseline with `checkParity` (`@statelyai/agent/testing`): `{ scenarios, effects: (s) => fakes, before: old, after: (input, fx) => step0.run(input, { effects: fx }) }`; every row `equivalent`. Ship it: inspection, traces, the event log, `signal`, a recorded baseline.
2. **Carve one phase per commit.** One phase becomes states (§3); the rest stays the old helper, invoked as a `createAsyncLogic` actor built per run from `effects`. Keep the `(input, effects)` runner signature with a third `options` argument passed through to `runAgent` (`threadId`, `store`, `metadata`, `onTrace`, `inspect`), so traces and inspection never need a copy of the runner. Move any prompt or warning text the carved phase sends into a versioned request config as you carve it: that file is what `improve-machine` may later edit. Run `checkParity` against the old code after each carve. Add the §6 proofs for the carved phase only.

A wrapped workflow is a black box: one state, no mid-function resume, no `canReach` about its inside. Do not report proofs before the phase is carved. Worked example: `examples/strangler-fig`. A class whose loop calls its own private model/tool methods: replace those methods on the instance inside `run` so they call `effects` (no edit to the class). Effect-TS generators, Redux thunks, LangGraph graphs, closures in DI factories, and step loops inside the model SDK have their own seams: [docs/strangler-fig.md](../../docs/strangler-fig.md#seams-for-other-shapes). Effects bound to one call's live objects: create the workflow once, pass `run(input, { effects })` per call. Scrub generated ids and timestamps: `compare.normalize` for effect arguments, `normalizeOutput` for the output, `normalizeError` for thrown errors.

**A phase in the middle of a private method:** copy only that phase's lines into the carved actor, list the copied line ranges in a comment, and let `checkParity` call-args catch drift. When a public per-turn hook exists, replace that method on the instance instead and let the machine decide at that boundary ([reference.md](reference.md#a-phase-in-the-middle-of-a-method)).

This is step 1 of 4. Next: `add-traces`, then `add-evals`, then `improve-machine`. To author a machine with no existing code, use `generate-machine`. Recording, replay, and the full parity test code are in [reference.md](reference.md).

## Hard rules

- **Pin the baseline before you change anything.** The parity test runs against the old code, which stays in the repo, untouched, until a person deletes it. When the old code cannot run, the baseline is a written behavioral spec (see "No model in the loop").
- **Never promise "behaves exactly like".** Promise what the parity evidence shows, every difference labeled.
- **Never copy a rule break.** Where the old code broke a rule, the machine blocks it. That difference is `intended`, not a regression.
- **Rules are code, not prompt text.** A prompt-only rule becomes a guard; the prompt line stays only as context.
- **Business rules belong to people.** Ambiguous rule (which threshold, which order)? Ask; never pick silently.
- **Port call shapes unchanged first.** An SDK tool call stays a text request with the same tools. Changing it (to `agent.decide` or `agent.act`) is a separate step with its own `INTENDED` divergences.

## 0. Before you write code

- Text requests need exactly one non-empty `prompt` or `messages`. `setupAgent` throws `invalid-request` when both are omitted; resolving neither or both at run time fails validation.
- Actors: `createAsyncLogic<Output, Input>({ run })` from `xstate` (no `fromPromise` in v6); without the generics `onDone`'s `output` is untyped.
- `onIdle` return events need `as const` on `type`, or the union does not narrow.
- In `onError`, the error is `event.error`; there is no `error` argument.
- Context, input, events, outputs: JSON only. No `Date`, `Error`, `Map`, class instances, functions; store ISO strings and `String(error)`.
- Every executor slot is optional in the type; assert the ones you call.
- `request.metadata.facts` is `unknown`; parse it with the exported facts schema.
- A `type: "choice"` state has no `enq` or actions; when routing must emit, use `always` on a normal state.
- `compareRuns` scenarios reserve `expected: string` for the outcome; name other expectations differently.
- `explorePaths` `errors[src]`: an array forks one failing branch per element (`[[...]]` for an array-valued failure). `outputs` and `errors` branches are alternatives, not a sequence: drive "fails twice, then succeeds" from a context counter.

### Inspect one event

`transition(machine, snapshot, event)` from `xstate` is pure: it returns the next snapshot and the effects it would run, and runs none of them. Use it to answer "what happens if this event arrives here?" before writing a test or running the loop.

```ts
import { initialTransition, transition } from "xstate";

const [s0] = initialTransition(machine, { maxTurns: 2 });
const actorId = Object.keys(s0.children)[0]; // the running invoke
const [s1, effects] = transition(machine, s0, {
  type: "xstate.done.actor",
  actorId,
  output: { done: false },
});
s1.value; // next state
s1.context; // next context
effects; // what would run (spawn, start, stop, ...); nothing ran
```

- Same snapshot object back and no effects: the event is unhandled there.
- Fail an invoke with `{ type: "xstate.error.actor", actorId, error }`.
- To start mid-run, pass a live snapshot: `restoreActor(machine, persisted).getSnapshot()` (`xstate/persist`) for a persisted one, or the snapshot `replay` (`@statelyai/agent/log`) folds from a journal. A raw persisted snapshot throws.

## 1. Inventory the code

Read the loop and fill this table before writing anything. Each row maps to a machine element.

| In the code | Becomes |
| --- | --- |
| A tool with a side effect someone must gate (refund, send) | An actor invoked by one state, entered only through a guarded transition |
| A read-only tool (search, lookup) | An actor the machine invokes, or a tool on a text request |
| A rule: an `if`, a prompt line, a check after the fact | A guard on the transition it protects |
| A model call that produces content | A text request in `setupAgent({ requests })`, invoked by one state |
| One SDK tool call that picks the action and carries its content (`send_email({ … })`) | A text request with those tools, then shape guards on the returned call: exactly one, offered, schema-valid. A tool that keeps `execute` runs inside the SDK (old timing); to gate it, drop `execute` and invoke the real work after the verdict. Not `agent.decide` yet: it hides your tool names and descriptions |
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
| A streaming iterator | The `streamText` executor keeps it and pipes to the old consumer. In a wrapped workflow, an effect returning it is observed: `effect.done` carries the chunks once read, a mid-stream throw is `effect.error` |
| A step loop inside the model SDK (`stopWhen`, `maxSteps`) | One executor or effect, unchanged. Carve the control flow around it: handoff, approval, caps |
| A synchronous host callback, a diagnostic logger | Not an effect: the machine factory closes over it |
| An effect result that is a live object, a write to host state by reference | A name, id, or change in the result, with a host-side registry. Parity cannot see the live object or the write |
| Mutable state on the class instance | JSON context fields, or host state passed as input |
| A cap on a loop the machine keeps / removed | A `choice` state against an exported constant / nothing, with the reason recorded |
| A class-shaped runtime (`run`/`continue`/`abort`/`restore`/`snapshot`) | A subclass overriding the loop methods to call `runAgent`, inheriting the rest. The conversation may stay host-owned at first (a snapshot then cannot resume alone); moving it into context is a later labeled step |
| A function that returns a live stream at once (`streamText`-shaped) | Return at once from a `TransformStream` the run writes into: an `emit` effect writes each chunk, the run closes the writer when it succeeds and aborts it with the error when it fails, and the result's promise fields resolve from the run. The machine owns the loop; the caller reads the stream as before |
| A live receiver the effects need (a class instance, an open stream, a cancellation token) | A host registry keyed by id: context and events carry the id, each effect looks the object up |
| Each distinct return | A final state |
| A terminal tool with a side effect (`escalate`) | A state that invokes it, then the final; `onError` to a `failed` final |

Number the rules in your notes. Each ends as a guard, a state ordering, or a written reason it was dropped.

A loop with no decision point is still worth converting: caps, rules, and failure paths become provable. Skip step 4 and the decision parts of step 5.

## 2. Pin the baseline

The parity test exists before the machine does.

1. **Scenarios.** Reuse the code's tests, fixtures, or benchmarks: an `id` each and, where known, the `expected` outcome. If none exist, draft 6–10 covering every terminal and rule; ask the user to confirm them.
2. **Deterministic stand-in models.** The code's mocks, or a function from the request (prompt or `name`) to a fixed answer ([`examples/mock-model.ts`](https://github.com/statelyai/agent/blob/next/examples/mock-model.ts), repo only). Two: one follows the rules, one breaks them. A seeded model seeds from the scenario id, fresh per run.
3. **Ground truth.** Outcomes and effects from the world, not the agent's report. `effects` holds **every write the world records**: refunds, approvals, verifications, questions asked, escalations. Model-written text: compare count or presence. Violations come from the world, or a plain function over the effects.
4. **A baseline with no function to call.** Loop inline in a framework handler: call the handler with stand-in model and storage. Do not extract the loop first.
5. **Record golden runs.** `createRecorder` (`@statelyai/agent/testing`) wraps model and tools; run the old code per scenario and stand-in, save JSON fixtures. AI SDK model → `recorder.model`; `openai` client → `recorder.openai`; anything else → `recorder.client` on the SDK object (`methods: ["messages.create"]`), or `recorder.fn` on a function. Code, streams, and `redact`/`serialize`/`revive`: [reference.md](reference.md#any-other-model-client).
6. **The harness check.** The old code on both sides of `compareRuns`, per stand-in: baseline equals candidate in every row; all `same` with the rule-following model, `regression` by design with the rule-breaker. [reference.md](reference.md#the-parity-harness).

### No model in the loop

For code with no model call (a tool scheduler, an approval queue), and old code that cannot run (a class wired to a bus, no callable entry). A tool runner whose text request picks tools has a model in the loop: keep recorders and replay (§7); use the spec baseline only where the old code cannot run.

- **Skip recorders only when nothing calls a model.** Then replay (§7) does not apply.
- **Baseline as spec.** When the old code cannot run, `baseline: async (s) => SPEC[s.id]`: outcome, effects, and violations a person confirmed from the old code and its docs, before the machine exists. Skip the harness check; the hand-back says the baseline is a spec, not a run.
- **Stand-ins become scripted worlds:** the proposed calls, the order approvals arrive in, which tool fails.

## 3. Author the environment

The environment is the machine: states, guards that encode the rules, side-effecting actors, an invariant sentinel. Use `setupAgent` (from `@statelyai/agent`) with schemas for `input`, `context`, `output`, and every event. A zod `z.object` strips keys it does not list at the boundary; list every field the old code reads, or use `z.looseObject`. It takes any Standard Schema library (zod, valibot, arktype); the package ships none, so install one. Pass the schemas as top-level fields, `setupAgent({ context, input, output, events })` (`context` is required), or as one `schemas: createAgentSchemas({ ... })`; a partial object under `schemas` does not typecheck. Export the event schemas as one object for a later policy. A gated action (closed-choice `agent.decide`, guard in the transition) is in [reference.md](reference.md#a-gated-action).

- **Do the deterministic steps yourself.** Identity, lookup, ownership: states in order. A model answers only what needs judgment.
- **Write simple guards inline** (`context.turn < context.maxTurns`): `describeMachine(machine, { source: true })` prints them. Export a guard as a plain function only when a test must loosen it, build the machine in a factory (`createDeskMachine({ refundIsLegal })`), and pass the same functions as `helpers` so the read-back still shows their bodies: `describeMachine(createDeskMachine(guards), { source: true, helpers: guards })`.
- **Add an invariant sentinel** for the rule that must never break: a final state described `SENTINEL: …`, entered from an `always` on the side-effect state (`paying`), which runs before the invoke starts. The check is its own function, not the guard, so a loosened guard does not loosen it.
- **A person's step** is an idle state whose `meta.interaction` tells a host what to render: `{ label, events: { APPROVE: { label: "Approve" }, REJECT: { label: "Reject" } } }`, or `textEvent: { type: "CUSTOMER_REPLIED", field: "reply" }` for free text.
- **Actors are placeholders** in `setupAgent({ actors })`; pass the real ones with `runAgent(machine, { actors })`.
- **Final outputs carry the result** (`{ outcome, orderId, amount }`); the runner rebuilds the old return type from it and the world.
- **Declare `version`** in `createMachine({ id, version: "1", ... })` on every recorded machine; bump it on every behavior change. Traces stamp it (`add-traces` §1).

## 4. A policy, only if the code already has one

Keep the decision in the environment as one `agent.decide`, with no policy machine, unless the old code has decision logic beyond one model call: a rule ladder, strategy heuristics, a cheap check before the model. `improve-machine` introduces a policy when traces show a rule worth adding. If the code has that logic, port it as a policy machine that answers the decision: [policy.md](policy.md).

## 5. The runner

Write `runMachine` with the old function's signature and result type.

- **The existing SDK call becomes the executor.** `generateText` (or `streamText`) in `executors`, as the old call: same model, system prompt, tools, options, retry code; return `{ result }`. Pass the conversation as `messages: ({ input }) => input.messages`.
- **A streaming route keeps its response, not its signature.** `createAiSdkExecutors().streamText` forwards text chunks only, so wrap the old call: pipe its stream to the old consumer, then return `{ result: finalValue, messages: responseMessages }` so later requests can rebuild the assistant and tool history from `output.messages`.
- `runAgent(machine, { input, executors, actors, onIdle })`. `onIdle` answers each idle state with the old code's call.
- `executors.decide` reads `request.options` (each `{ event }`) and `request.metadata?.facts`.
- JSON-safe input and events: with a store, an unloggable value fails the run.
- Rebuild the old result from `result.output` and the world. A field with no meaning now keeps its type and a comment.

**Approvals off a message bus.** The rule: nothing else runs while the answer is awaited → idle state + `onIdle`. Other calls in flight, or answers in any order → never idle, so invoke a wait actor: `createCallbackLogic` that subscribes to the bus, sends `APPROVED`/`REJECTED` with the call id to its parent, and unsubscribes on exit. For N calls per batch (per-call approve/reject/always, a barrier before execute, cancel-all), use `createApprovalBatchMachine` from `@statelyai/agent/machines` ([docs/machines-presets.md](../../docs/machines-presets.md)). Only when it does not fit, hand-write a child machine per batch.

**Host events mid-run** (cancel, abort, a user message while a request runs):

- A legacy body that owns abort (it returns its own `stopped` result) during a partial carve: pass the signal to the legacy body only, not to `runAgent`, so its result stands and reaches the machine as a normal final.
- Abort: `runAgent`'s `signal` alone is a hard stop: the run settles `{ status: "error", cause: "aborted" }` and the machine sees nothing. Add `abortWith: { event, timeout? }` when the machine should handle it (a `cancelled` final, cleanup invokes); it falls back to `aborted` if the event is unhandled, if the machine is still active once the event has been applied and the run settles, or on timeout: the handled path must reach a final or idle state before you can rely on its cleanup.
- A cancel the machine handles (cleanup, a `cancelled` final): a `CANCEL` event on the parent state. With `runAgent`, pass `inbox: createAgentInbox()` and call `inbox.send(event)`; an inbox serves one run. A hand-written `createAgentRuntime` loop uses `runtime.send(event)` ([docs/hosts.md](../../docs/hosts.md)).

## 6. Proofs that need no model

From `@statelyai/agent/testing` (example options in [reference.md](reference.md#proof-options)):

- `lintAgentMachine`: no errors. An invoke whose error must reach the caller unchanged has no `onError` (the runner rethrows `result.error`); pass `disable: ["invoke-without-on-error"]` for that machine. For one invoke that cannot fail (a callback bridge), pass `ignore: [{ code: "invoke-without-on-error", path: "<state>" }]` instead.
- `canReach(machine, "<sentinel>", options)` returns `reachable: false` **and** `complete: true`, for each distinct input shape (with and without an order id; loop over them).
- `options.payloads(snapshot)` returns payload lists per event type, on both sides of every guard boundary (`0`, the threshold and one over, each producible amount and one over); without it `complete: true` proves nothing about boundaries. A person's free-text event needs one payload per branch.
- `outputs`: every output each actor can return; `errors`: each actor fails. An actor that never settles (a callback bridge, a long-lived listener) gets `outputs: { src: [] }`: its invoke stays pending and only events move the machine.
- **A loop** needs `options.dedupeBy`, or the search hits `maxDepth` with `complete: false`. Key on the state value plus the fields read at the loop head (counters, flags); drop fields that only change within one pass. A search over a few seconds: cut the key first. A counter cap of N needs `maxDepth` above N times the events per pass; with the default the search ends `complete: false`.
- A state passed through within one step (left at once by `always`, or a `choice` state) counts as reached: `canReach` returns the path through it and `explorePaths` lists it in `reachedStates`, so it works as a sentinel.
- **A machine that spawns or invokes children**: pass `children: "coupled"`, `childEvents` (only the types the host sends a child directly; the parent's sends need no entry), and `hostEvents` when child status events must not be forged by the host. A witness is then a run the machines can make together. Read `vacuous`. Use `interleave: "pending"` only for the invariant that needs host events raced against in-flight work, and for a long-lived invoke that hands calls back through an inbox: without it, events that arrive while the invoke runs are never explored.
- A loosened guard makes `canReach` true; test that too.
- Each normal final is reachable (the search is not vacuous).

Type options with `ExplorePathsOptions` and callback snapshots with `ExploreSnapshot` (`@statelyai/agent/testing`), not your app's `AnyMachineSnapshot`.

## 7. Parity

Switch the candidate to `runMachine`; run per stand-in (or against the spec). Code in [reference.md](reference.md#the-parity-harness).

- Every `regression` row: fix the machine, or ask the user when the old behavior was wrong but broke no rule. Differing outcomes: the answer may become `expected`. Differing effects only: list the row in a reviewed-differences map, exact difference asserted, with who accepted it. Never edit a scenario to make a row pass.
- **Run the old suite against the port**, the strongest evidence when the old code has tests: mock the old module (`vi.mock('../old-module', ...)`) with a subclass whose loop methods call `runAgent`, plus a canary counter the machine increments. Assert the exact count (the N runs the suite drives), not `> 0`. A test that spies on internals the port no longer calls is a structural failure: mark it `it.fails` with a comment naming why; never delete it. Snapshots are stored under the importing file's name, so a `toMatchSnapshot` there writes a new snapshot and passes: copy the old `__snapshots__/<old>.snap` to the swap file's name and run with `CI=true`, so a missing snapshot fails.
- **Swap pitfalls.** A mock factory that imports the port deadlocks when the port imports the mocked module: load the port with a dynamic import in `beforeAll` and call it from inside the factory's functions. A mock that misses the code's own import of the module: patch the class prototype from a setup file that imports the module dynamically. Code in [reference.md](reference.md#old-suite-swap).
- **Timing.** `runAgent` starts asynchronously, so fire-and-forget work the old code starts at the same time may settle in another order. An old test asserting exact action order across concurrent tasks is structural only after you confirm the actions commute and their order is not part of the contract; an order users or storage see is behavioral.
- Every `intended` row: its reason is a real rule. A fixed rule break with the same outcome is `intended` too.
- With recordings, replay each against the machine (`createRecorder({ replay })`, `compareRecordings`): no key, no side effects, every divergence in `INTENDED` with who accepted it, including a guard that blocks a rule break. Semantics in [reference.md](reference.md#replay-equivalence).
- With no model in the loop, parity is the whole proof: the spec baseline plus §6. Say so.

## 8. Hand back

Report, in this order:

1. The files (environment, runner, tests, any policy); the old code untouched.
2. The rule list, each mapped to a guard, a state, or why it was dropped.
3. The parity table per stand-in model: `same / intended / regression`, one line per `intended` row with its reason. Say whether the baseline was a run or a spec.
4. The `canReach` results and the loosened-guard test.
5. The machine rendered: `describeMachine(machine)` output, and how to watch it live in the Stately inspector (install `@statelyai/sdk` and its optional peer `ws` for a local relay, and pass `inspector.inspect` as `runAgent`'s `inspect`; see [docs/observability.md](../../docs/observability.md)).
6. Anything you had to decide that the user should confirm, including where message history lives.
7. Next step: `add-traces`.
