---
name: loop-to-machine
description: Convert existing agent code (a while-loop around a model, a tool loop, ad-hoc if/else control flow) into an XState v6 state machine with @statelyai/agent, and prove with a parity report that it behaves like the code it replaces. Use when asked to "turn this agent into a state machine", "port my loop to xstate", "make this a statechart", "refactor this agent into a machine", or "split environment and policy" for code that already runs.
---

# Convert agent code to a machine

You replace the control flow of working agent code with a machine, and show where the machine behaves like the old code and where it differs on purpose. The model calls, tools, and retry code move across unchanged.

```
inventory → pin the baseline → environment → (policy) → runner → proofs → parity → hand back
```

This is step 1 of 4. Next: `add-traces`, then `add-evals`, then `improve-machine`. To author a machine with no existing code, use `generate-machine`.

## Hard rules

- **Pin the baseline before you change anything.** The parity test runs against the old code, which stays in the repo, untouched, until a person deletes it.
- **Never promise "behaves exactly like".** Promise what the parity report and the replayed recordings show: equivalent effects on these scenarios, with every difference labeled.
- **Never copy a rule break.** Where the old code broke a rule, the machine blocks it. That difference is `intended`, not a regression.
- **Rules are code, not prompt text.** A rule that lived only in a system prompt becomes a guard. Keep the prompt line only as context for the model.
- **Business rules belong to people.** If a rule is ambiguous (which threshold, which order of checks), ask. Never pick one silently.

## 1. Inventory the code

Read the loop and fill this table before writing anything. Each row maps to a machine element.

| In the code                                                                  | Becomes                                                                  |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| A tool with a side effect someone must gate (refund, send)                   | An actor invoked by one state, entered only through a guarded transition |
| A read-only tool (search, lookup)                                            | An actor the machine invokes itself, or a tool on a text request         |
| A rule: an `if`, a prompt line, a check after the fact                       | A guard on the transition it protects                                    |
| A model call that produces content (a draft, generated code, a summary)      | A text request in `setupAgent({ requests })`, invoked by one state       |
| One SDK tool call that both picks the action and carries its content (`edit_graph({ … })`, `send_email({ … })`) | A text request with those tools, then guards on the returned call: exactly one, a tool that was offered, input that passes the tool's schema. Keep it a text request: `agent.decide` would rename the tools to `send_event_<TYPE>` with the description "Choose the '<TYPE>' move.", so the model would no longer see your tool names and descriptions |
| A tool the browser runs (no `execute`; the client sends results back)        | The request ends with the tool calls; an idle state waits for a `TOOL_RESULTS` event the route sends when the client posts results |
| A point where the model picks what to do                                     | A decision state: `agent.decide`, usually a closed choice                |
| A check on the model's output, then a retry or a repair call                 | An actor or guard that checks it, and a `choice` state that routes to the repair request, the next candidate, or a failure final |
| A value the model pulled out of the input (an order id, an amount)           | Code when the format is fixed (a regex); a text request when it is not   |
| A step every correct run takes in the same order (verify, then look up)      | A state the machine enters itself; the model no longer chooses it        |
| A person in the loop: `await approve()`, a returned `pending`, or a tool that asks a person (`askCustomer`, `requestApproval`), even a synchronous one | An idle state with `meta.interaction`, answered by `onIdle` in the runner |
| A cap (`turns < 8`, a retry counter) on a loop the machine keeps             | A `choice` state against an exported constant                            |
| A cap on a loop the machine removed                                          | Nothing. Record that it is gone and why                                  |
| Each distinct return                                                         | A final state                                                            |
| A terminal tool with a side effect (`escalate`, `close`)                     | A state that invokes it, then the final state; its `onError` goes to a `failed` final |

List the rules as a numbered list in your notes. Every one must end as a guard, a state ordering, or a written reason it was dropped.

A loop with no decision point (generate, validate, repair) is still worth converting: the machine makes the retry cap, the validation rules, and every failure path explicit and provable. It has no `agent.decide`, so step 4 and the decision parts of step 5 do not apply.

## 2. Pin the baseline

The parity test exists before the machine does.

1. **Scenarios.** Reuse the code's tests, fixtures, or benchmark cases. Each has an `id` and, where people know it, the `expected` outcome. If there are none, draft 6–10 that cover every terminal and every rule, and ask the user to confirm them.
2. **Deterministic stand-in models.** Parity with a live model drifts between runs. Use the code's scripted or mock models if it has them; otherwise write one: a function from the request (its prompt, or its `name`) to a fixed answer. ([`examples/mock-model.ts`](https://github.com/statelyai/agent/blob/next/examples/mock-model.ts) in the `statelyai/agent` repo is one, built on the AI SDK's `MockLanguageModelV3`; it is not in the package.) You want two: one that follows the rules, and one that breaks them. A seeded random model needs its seed derived from the scenario id and a fresh instance per run, or every scenario replays the same draws.
3. **Ground truth.** Read outcomes and effects from the world, not from the agent's own report. `effects` holds **every write the world records**: the refunds, and also the approvals, the verifications, the questions asked, the escalations. A refund issued without its approval looks correct if `effects` holds only refunds. Text a model wrote (an escalation reason) differs on every run: compare its count or presence, not the text. If the world can check rules after the fact, return those violations. If it cannot, write the check as a plain function over the effects.
4. **A baseline with no function to call.** When the loop lives inline in a framework handler (a tRPC procedure, a route), call the handler itself in the test, with its model client and storage replaced by the stand-ins (a module mock, or the framework's test caller). Do not extract the loop into a function first: that changes the code you are trying to pin.
5. **Record golden runs.** When the code calls the model through the AI SDK or the `openai` client, record each scenario's effects: every model call, every tool call with its arguments and result, and the output. Wrap the model and tools with a recorder from `@statelyai/agent/testing`, run the old code, and save the recording as a JSON fixture. Step 7 replays it against the machine with no API key and no side effects.

```ts
import { createRecorder } from "@statelyai/agent/testing";

const recorder = createRecorder();
const model = recorder.model(openai("gpt-5")); // or recorder.openai(new OpenAI())
const tools = recorder.tools(appTools); // AI SDK tools; recorder.tool(name, fn) for plain functions
recorder.output(await runLoop({ ...scenario, model, tools }));
writeFileSync(`fixtures/${scenario.id}.json`, JSON.stringify(recorder.recording));
```

   Record with the live model to capture real answers, or with a stand-in model. Either way the recording is the script for replay. One recording per scenario and per stand-in.
6. **The harness check.** Run the old code on both sides with each stand-in model. Each row's baseline must equal its candidate (the runs are deterministic), and with the rule-following model every row must be `same`. With a rule-breaking model, rows are `regression` by design: the candidate breaks rules.

```ts
import { compareRuns, type ParityResult, type ParityRun } from "@statelyai/agent/testing";

function toParityRun(run: { outcome: string; world: World }): ParityRun {
  return {
    outcome: run.outcome,
    // Every write the world records; model-written text as a count.
    effects: { refunds: run.world.refunds, approvals: run.world.approvals, verified: [...run.world.verified], escalations: run.world.escalations.length },
    violations: run.world.violations, // rules broken, from ground truth
  };
}

// A model factory, called once per scenario and per side. Construct a stateful or seeded
// model inside it (seeded from s.id); returning a shared stateless object is fine.
const runWith = (runner: typeof runLoop, model: (s: Scenario) => Model) => async (s: Scenario) =>
  toParityRun(await runner({ ...s, model: model(s), world: createWorld(s) }));

const MODELS: Array<[string, (s: Scenario) => Model]> = [
  ["careful", () => carefulModel],
  ["sloppy", () => sloppyModel],
];

test.each(MODELS)("harness: the loop matches itself (%s)", async (_, model) => {
  const report = await compareRuns({ scenarios: SCENARIOS, baseline: runWith(runLoop, model), candidate: runWith(runLoop, model) });
  for (const row of report.scenarios) expect(row.candidate, row.id).toEqual(row.baseline);
});
```

## 3. Author the environment

The environment is the machine: states, guards that encode the rules, side-effecting actors, an invariant sentinel. Use `setupAgent` (from `@statelyai/agent`) with zod schemas for `input`, `context`, `output`, and every event. Export the event schemas as one object, so a policy can reuse them later.

A gated action:

```ts
deciding: {
  tags: ["decision"],
  invoke: {
    src: "agent.decide",
    input: ({ context }) => ({
      model: "decider", // a key the host's executors resolve
      name: "chooseResolution", // tests, traces, and a later policy find it by this name
      prompt: `Ticket: ${context.ticket}\nOrder: ${JSON.stringify(context.order)}`,
      allowedEvents: ["REFUND", "ESCALATE", "CLOSE"],
      // A closed choice: the decider picks one of these. The runtime drops the ones the guards refuse.
      payloads: { REFUND: refundAmounts(context).map((amount) => ({ amount })) },
      // The facts a decider reads. Arrives as `request.metadata.facts`.
      metadata: { facts: { order: context.order, requestedAmount: context.requestedAmount } },
    }),
    onError: { target: "escalating" }, // retries exhausted, or no option legal
  },
  on: {
    REFUND: ({ context, event }) =>
      refundIsLegal(context, event.amount)
        ? { target: event.amount > APPROVAL_THRESHOLD ? "awaitingApproval" : "paying", context: { amount: event.amount } }
        : undefined, // undefined rejects: the decision retries with feedback
    // `escalate` and `close` are tools with side effects: states that invoke them, then the final states.
    ESCALATE: { target: "escalating" },
    CLOSE: { target: "closing" },
  },
},
```

- **Do the deterministic steps yourself.** Identity, lookup, the ownership check: states the machine runs in order. A model only answers what genuinely needs judgment.
- **Export the guards** as plain functions (`refundIsLegal`) so tests can call them, and build the machine in a factory (`createDeskMachine({ refundIsLegal })`) so a test can pass a loosened guard.
- **Add an invariant sentinel** for the rule that must never break: a final state with a description starting `SENTINEL:`, entered from an `always` on the state that invokes the side effect (`paying`). An `always` is taken before the state's invoke starts, so the effect never runs. Write the check as its own function, not a call to the guard, so loosening the guard does not loosen the check.
- **A person's step** is an idle state whose `meta.interaction` tells a host what to render: `{ label: "Approve a refund of ${amount}?", events: { APPROVE: { label: "Approve" }, REJECT: { label: "Reject" } } }`, or `textEvent: { type: "CUSTOMER_REPLIED", field: "reply" }` for free text.
- **Actors are placeholders.** Declare each tool as `createAsyncLogic<Output, Input>({ run })` from `xstate` in `setupAgent({ actors })` (XState v6 has no `fromPromise`). Give the type parameters, or `onDone`'s `output` is untyped. Pass the real implementations at run time with `runAgent(machine, { actors })`.
- **Final outputs carry the machine's result** (`{ outcome, orderId, amount }`), JSON only. The runner rebuilds the old return type from it and from the world (step 5).
- **Declare `version`** on `createMachine` (`version: "1"`). Behavior lives in transition functions, which the structural hash cannot see; traces stamp this string.

## 4. A policy, only if the code already has one

Keep the decision in the environment as one `agent.decide`, and do not write a policy machine, unless the old code already has decision logic beyond one model call: a rule ladder, heuristics that pick a strategy, a cheap check before the model. A policy that only passes the options through to a model is boilerplate. `improve-machine` introduces a policy when the traces show a rule worth adding.

If the code does have that logic, port it as a policy machine that answers `chooseResolution`. The pattern, with code that compiles, is in [policy.md](policy.md).

## 5. The runner

Write `runMachine` with the old function's signature and result type, so callers and the parity test change one line.

- **The existing SDK call becomes the executor.** Write `generateText` (or `streamText`) in `executors` as the old call, with the same model, system prompt, tools, and options, and return `{ result }`. The request still needs `prompt` or `messages` in `setupAgent({ requests })` (`setupAgent` throws `invalid-request` otherwise): pass the conversation as `messages: ({ input }) => input.messages` and read `request.messages` in the executor.
- **A streaming route keeps its response, not its function signature.** `createAiSdkExecutors().streamText` forwards text chunks only, so a UI stream with tool calls cannot come out of it. Write the `streamText` executor around the old call, pipe its UI stream to the route's response yourself, and return the final messages as `{ result }`.

- `runAgent(machine, { input, executors, actors, onIdle })`.
- `onIdle` answers each idle state with the old code's call (`tools.askCustomer(...)`, `tools.requestApproval(...)`). Write the returned events with `as const` on `type`, or the event union does not narrow.
- `executors.decide` adapts the code's model to the decision: the closed choice arrives as `request.options` (each `{ event }`), and the facts as `request.metadata?.facts`, typed `unknown`: parse it with the exported facts schema. Every executor slot is optional in the type; check or assert the ones you call.
- In an `onError` function, the error is `event.error`: `onError: ({ event }) => ({ target: "failed", context: { error: String(event.error) } })`. There is no `error` argument.
- Make input and events JSON-safe at the boundary: no `Date`, `Map`, class instances, or functions (fields set to `undefined` are dropped). With a store, a value the log cannot hold fails the run; without one, the log stops with a warning.
- Rebuild the old result from `result.output` and the world. A field that has no meaning anymore (a turn count with no loop) keeps its type and gets a comment saying what it now holds.

## 6. Proofs that need no model

From `@statelyai/agent/testing`:

- `lintAgentMachine(machine)`: no errors.
- `canReach(machine, "<sentinel>", options)` returns `reachable: false` **and** `complete: true`, for each distinct input shape (an input with an order id and one without lead to different paths; loop over them).
- `options.payloads` is a function of the snapshot that returns payload lists per event type. List values on both sides of every guard boundary: `0`, the threshold and one over, and each order amount the outputs below can produce and one over. Without it, a closed choice is explored only with its own `payloads`, and `complete: true` then proves nothing about the boundaries.
- A free-text event from a person's step (`CUSTOMER_REPLIED`) needs an entry too, one payload per branch it can take, or the search cannot send it.

```ts
const proofOptions: ExplorePathsOptions = {
  payloads: () => ({
    REFUND: [0, 40, 41, 100, 101, 240, 241, 800, 801].map((amount) => ({ amount })),
    CUSTOMER_REPLIED: [{ reply: "It's ORD-1001" }, { reply: "no idea" }],
  }),
  outputs: { lookupOrder: [ownedOrder, otherCustomersOrder, refundedOrder, { found: false }] },
  errors: { lookupOrder: new Error("down"), "agent.decide": new Error("exhausted") },
};
```
- `options.outputs` lists every output each actor can return (found and not found, owned and not, refunded and not); `options.errors` makes each actor fail once.
- **A machine with a loop** (a repair cycle, a resubmit) needs `options.dedupeBy`, or the search runs to `maxDepth` and reports `complete: false`. Return every context field a guard or choice reads: `dedupeBy: (s) => JSON.stringify([s.value, s.context.attempts, s.context.lastError])`. `outputs` are canned per actor src, not per call: to explore "fails twice, then succeeds", let the guard read a counter from context instead of the output.
- `explorePaths(...).reachedStates` lists only states a run settles in; a `choice` state it passes through is not listed.
- A loosened guard makes `canReach` true. Write this test too, or the proof proves nothing.
- Each normal final state is reachable, so the search is not vacuous.

Type the options with `ExplorePathsOptions`, and a `payloads`, `dedupeBy`, or predicate callback's snapshot with `ExploreSnapshot`, both from `@statelyai/agent/testing`. Do not use `AnyMachineSnapshot` from your app's own `xstate`, which may be another version. `errors` takes one error per actor src, and `"agent.decide"` is a valid key.

## 7. Parity

Switch the parity test's candidate to `runMachine`, and run it with each stand-in model:

```ts
test.each(MODELS)("parity with the loop: %s", async (_, model) => {
  const report = await compareRuns({ scenarios: SCENARIOS, baseline: runWith(runLoop, model), candidate: runWith(runMachine, model) });
  const unreviewed = report.scenarios.filter((row) => row.label === "regression" && !REVIEWED[row.id]);
  expect(unreviewed).toEqual([]);
  // A reviewed difference still has to be exactly the difference a person accepted.
  for (const row of report.scenarios.filter((row) => REVIEWED[row.id])) REVIEWED[row.id]!(row);
});

// Effect-only differences a person accepted: who, and the exact difference.
const REVIEWED: Record<string, (row: ParityResult<Scenario>) => void> = {
  // "no-order-id-no-reply": (row) => { /* accepted by <name>: asks once, not three times */ expect(row.candidate.outcome).toBe(row.baseline.outcome); ... },
};
```

Then prove effect equivalence on every recording from step 2. Replay answers each model and tool call from the recording, so the machine needs no key and causes no side effects:

```ts
import { compareRecordings, createRecorder, type EffectDivergence, type Recording } from "@statelyai/agent/testing";

test.each(SCENARIOS)("equivalent to the recorded loop: $id", async (scenario) => {
  const recording: Recording = JSON.parse(readFileSync(`fixtures/${scenario.id}.json`, "utf8"));
  const replay = createRecorder({ replay: recording });
  const model = replay.model(openai("gpt-5")); // never called in replay
  replay.output(await runMachine({ ...scenario, model, tools: replay.tools(appTools) }));
  const report = compareRecordings(recording, replay.recording);
  expect(report.divergences.map(({ reason, message }) => ({ reason, message }))).toEqual(INTENDED[scenario.id] ?? []);
});

// Differences a person accepted: who, and the exact divergences.
const INTENDED: Record<string, Array<Pick<EffectDivergence, "reason" | "message">>> = {};
```

- Equivalent means the same model calls (count and shape: offered tool names, response format), the same tool calls with the same arguments, and the same output. Prompts and states may differ. Tool calls between two model calls compare in any order.
- Values that differ on every run (generated ids, branch names, timestamps) fail `tool-input`. Pass `compareRecordings(a, b, { normalize })` to redact them on both sides; never edit the fixtures.
- `divergences` lists every difference, lined up so one extra call does not shift the rest; `divergence` is the first.
- In replay, a model call past the recorded ones or a tool call the old code never made throws `RecordingDivergenceError`, and `compareRecordings` names it.
- `model-call-shape`: the machine changed a call's tools or output format, for example a model-picked action that became `agent.decide`. The recorded answer does not fit the new call, so equivalence ends there. Port the call unchanged first, prove equivalence, then change it in a separate step whose divergences are `INTENDED`. To keep replaying past a call you changed on purpose, pass the same `modelCalls` function to `createRecorder({ replay, modelCalls })` and `compareRecordings`: `(expected, actual) => expected.call === 2 || sameModelCallShape(expected, actual)`. The recorded answer must still fit the new call.
- A guard that blocks a rule break diverges on purpose. List it in `INTENDED` with the exact divergence.

- Every `regression` row: fix the machine, or, when the old behavior was wrong but broke no rule, ask the user. If the outcomes differ, the answer may become the scenario's `expected`. If only effects differ (the loop asked three times, the machine once), list the row in a reviewed-differences list in the test, with the exact difference asserted and the person who accepted it. Never edit a scenario to make a row pass.
- Every `intended` row: check that its reason is a real rule. A candidate that fixed a rule break with the same outcome is `intended` too.
- Run once with a live model if a key is available. Report it as one sample, not a guarantee.

## 8. Hand back

Report, in this order:

1. The files: environment, runner, tests (and a policy, if the code had one). The old code is untouched.
2. The rule list from step 1, each mapped to its guard, its state, or the reason it was dropped.
3. The parity table per stand-in model: `same / intended / regression`, and one line per `intended` row with its reason.
4. The `canReach` results and the loosened-guard test.
5. Anything you had to decide that the user should confirm.
6. Next step: `add-traces`.
