# Evals

Agent requests are independently executable, while the machine gives them meaningful state and trajectory context.

## Testing without a provider

A test runs the real machine through `runToQuiescence` and replaces only the model. `@statelyai/agent` ships no model mock. There are two ways to replace the model:

- Mock the provider with the AI SDK's `MockLanguageModelV3`. The call still runs through `createAiSdkExecutors`, so the test covers prompt rendering, structured output parsing, and decision tool calls.
- Pass plain functions as executors. The test covers the machine only.

Both examples below run this machine. It drafts an email, then scores the draft with a structured request.

```ts
import { z } from "zod";
import { setupAgent } from "@statelyai/agent";

const agent = setupAgent({
  input: z.object({ topic: z.string() }),
  context: z.object({ topic: z.string(), draft: z.string(), score: z.number().nullable() }),
  output: z.object({ draft: z.string(), score: z.number().nullable() }),
  requests: {
    draftEmail: {
      model: "writer",
      schemas: { input: z.object({ topic: z.string() }), output: z.string() },
      prompt: ({ input }) => `Write a short email about ${input.topic}.`,
    },
    scoreDraft: {
      model: "judge",
      schemas: {
        input: z.object({ draft: z.string() }),
        output: z.object({ score: z.number() }),
      },
      prompt: ({ input }) => `Score this email from 1 to 5:\n${input.draft}`,
    },
  },
});

const machine = agent.createMachine({
  context: ({ input }) => ({ topic: input.topic, draft: "", score: null }),
  initial: "drafting",
  states: {
    drafting: {
      invoke: {
        src: "draftEmail",
        input: ({ context }) => ({ topic: context.topic }),
        onDone: ({ output }) => ({ target: "scoring", context: { draft: output.result } }),
      },
    },
    scoring: {
      invoke: {
        src: "scoreDraft",
        input: ({ context }) => ({ draft: context.draft }),
        onDone: ({ output }) => ({ target: "done", context: { score: output.result.score } }),
      },
    },
    done: {
      type: "final",
      output: ({ context }) => ({ draft: context.draft, score: context.score }),
    },
  },
});
```

### Mock the model

`MockLanguageModelV3` from `ai/test` is the AI SDK's test double for a language model. Put one in the `models` map of `createAiSdkExecutors` under each model key the machine uses.

```ts
import { MockLanguageModelV3 } from "ai/test";
import { runToQuiescence } from "@statelyai/agent";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";

function mockModel(text: string) {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    }),
  });
}

const writer = mockModel("Checkout now supports saved cards.");
const judge = mockModel(JSON.stringify({ result: { score: 4 } }));

const result = await runToQuiescence(
  createAgentRuntime(machine, { executors: createAiSdkExecutors({ models: { writer, judge } }) }),
  { input: { topic: "saved cards at checkout" } },
);

if (result.status === "done") {
  console.log(result.output); // { draft: "Checkout now supports saved cards.", score: 4 }
}
console.log(judge.doGenerateCalls.length); // 1
```

The mock answers in the provider's format, not the request's:

- A plain-text request takes the text as is.
- A structured request asks the provider for JSON and reads the declared output from a `result` key, so the mock returns `{ "result": … }` as JSON text.
- An `agent.decide` request expects a `tool-call` content part. Its `toolName` is `send_event_<TYPE>` for the chosen event type, and its `input` is the event payload as JSON text.

`doGenerateCalls` records the options of every call, including the prompt the adapter rendered.

### Plain-function executors

An executor is a function of the request. Route on `request.name` to answer each request, and return the output value as `result`.

```ts
import { runToQuiescence } from "@statelyai/agent";

const calls: string[] = [];

const result = await runToQuiescence(
  createAgentRuntime(machine, {
    executors: {
      generateText: async (request) => {
        calls.push(request.name ?? "");
        switch (request.name) {
          case "draftEmail":
            return { result: "Checkout now supports saved cards." };
          case "scoreDraft":
            return { result: { score: 4 } };
          default:
            throw new Error(`No answer for request "${request.name}"`);
        }
      },
    },
  }),
  { input: { topic: "saved cards at checkout" } },
);

console.log(calls); // ["draftEmail", "scoreDraft"]
```

A `decide` executor routes the same way and returns the chosen event: `decide: async (request) => ({ event: { type: "APPROVE" } })`.

`request.name` is the request's `setupAgent({ requests })` key, the `createTextLogic`/`createDecisionLogic` `name`, or the `name` on an inline `agent.decide` input. Without one, it is the invoke `id`. Route on the name, not on prompt text or call order. A run that takes a different branch then fails with a missing answer instead of receiving an answer meant for another request.

An executor that throws reaches the machine as an ordinary actor error. An invoke that declares `onError` routes it like a model failure.

## Individual request evals

Call the executor directly when an eval targets one LLM call. Use the whole
machine for control-flow evals so schemas, transitions, and failure handling are
part of the assertion.

## Seam evals

`runSeam` (from `@statelyai/agent/testing`) runs the whole machine with one named request occurrence under test. The seam gets a `candidate` executor, and every other text request is answered from `scripts`. Omit `candidate` to script the seam too. Score its `seamOutput`, `calls`, state path, and XState transition events.

```ts
const run = await runSeam(machine, {
  input: { topic: "saved cards at checkout" },
  scripts: {
    draftEmail: ["Checkout now supports saved cards."],
    scoreDraft: [{ score: 4 }],
  },
  seam: { request: "scoreDraft" },
});

run.seamOutput; // { score: 4 }
run.calls.map((call) => call.source); // ["script", "script"]
```

`runSeam` routes text requests only. For a machine that also decides, pass a `decide` executor through `executors`.

### Script keys

A `scripts` key is a request `name` when `scripts` has a queue under that name. Otherwise it is the request's `model` key. A machine whose requests are named routes by name, and an unnamed one routes by model.

A request's name resolves as described in [Plain-function executors](#plain-function-executors): its declared `name`, else the invoke `id`. Name every request a script answers, so a call with no matching queue throws instead of taking an answer queued for another request.

### Entry shapes

An entry (`SeamScriptEntry`) is the request's **output value**: a bare string for a text request, or the object a structured request declares.

```ts no-check
scripts: {
  answer: ["Because transitions constrain behavior."],
  assess: [{ score: 4, notes: "clear" }]
}
```

An entry is read as an executor result instead only when its own keys are `result` plus, optionally, `messages`, `usage` and `raw`. That is how an entry reports token usage, which `run.seamUsage` reads for the seam call: `{ result: draft, usage: { totalTokens: 120 } }`. A structured request whose declared output is itself `{ result }` needs one more wrap: `{ result: { result: "…" } }`.

An entry may also be a function of the request: `answer: [(request) => "Draft about " + request.prompt]`.

### Order and repetition

Entries for a key are consumed in order. The seam consumes its slot even when `candidate` answers it, so later entries stay aligned with the call plan.

A queue that runs dry throws an `AgentError` with code `seam-script-exhausted`, naming the request. Pass `repeatLast: true` to replay a queue's last entry instead, for a live seam that sends the run down a longer branch.

## Per-state stats

`foldTraces` (from `@statelyai/agent/testing`) folds many runs' traces into one row per state: how many runs visited it, how many of those failed, how many options the guards withheld at decisions made there, and how many events it ignored.

```ts no-check
import { foldTraces } from "@statelyai/agent/testing";

// One AgentTraceEvent[] per run, collected with onTrace.
const stats = foldTraces(traces, {
  failed: (trace) => {
    const end = trace.at(-1);
    return end?.type !== "run.end" || !end.snapshot.matches("refunded");
  },
});
// [{ state: "deciding", visits: 2, failures: 1, withheld: 2, ignored: 0, blamed: 0 }, ...]
```

- A trace is one run's events, live or from `serializeTraceEvent`. `failed` judges the whole trace.
- A run visits each state in a `machine.transition`'s `from.value` and `snapshot.value`. Nested states are dot-joined paths; a parallel state counts once per active leaf.
- `withheld` comes from a decision's first `request.start`: the length of `request.withheld`, counted toward the state the run was in, which is the `from.value` of the transition the choice causes.
- `ignored` counts `machine.transition` events with `ignored: true`: a host event the state had no transition for, counted toward that state.
- `decideNext` called by the host emits no trace. Push its request onto the trace before sending the event: `trace.push({ type: "request.start", request: result.request })`.
- Rows come in the order states were first seen. Sort them yourself, for example by `failures / visits`.
- `failures` counts a failed run against every state it visited, so the states after a bad decision rank as high as the decision. Pass `blame` to count each failed run once, against the state its failure started in. See [Where failures start](#where-failures-start).

## Decision requests from traces

`getDecisionRequests` (from `@statelyai/agent/testing`) lists the decisions a run asked for, read from its trace: each decision's first `request.start`, and the states the run was in.

```ts no-check
import { getDecisionRequests } from "@statelyai/agent/testing";

for (const { states, request } of getDecisionRequests(trace, { name: "chooseResolution" })) {
  const { event } = await decide(request); // a candidate decider
  console.log(
    states,
    request.options?.map((o) => o.event),
    event,
  );
}
```

- A trace is one run's events, live or from `serializeTraceEvent`. Retries of a decision are left out, so each decision appears once.
- A serialized request keeps its `options`, `withheld`, `metadata`, `system`, and `prompt`. Event schemas do not survive serialization, so replay closed choices rather than open ones.
- Use the requests as eval rows (a decider on each, compared with a label) or as probe inputs for a policy.

## Parity with the code you replace

`compareRuns` (from `@statelyai/agent/testing`) runs every scenario through the existing implementation and its replacement, and labels each difference. Use it when you port a loop to a machine and need to show where they behave the same and where the machine differs on purpose.

```ts no-check
import { compareRuns } from "@statelyai/agent/testing";

const report = await compareRuns({
  scenarios, // [{ id, expected?, ...your fields }]
  baseline: async (scenario) => {
    const run = await runRawLoop(scenario);
    return { outcome: run.outcome, effects: run.world.refunds, violations: run.world.violations };
  },
  candidate: async (scenario) => {
    const run = await runDesk(scenario);
    return { outcome: run.outcome, effects: run.world.refunds, violations: run.world.violations };
  },
});
expect(report.ok).toBe(true); // no regressions
// report.counts: { same: 7, intended: 3, regression: 0 }
```

| Label        | When                                                                                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `same`       | Same `outcome`, structurally equal `effects`, and neither run broke a rule                                                                            |
| `intended`   | The candidate broke no rule, and the baseline broke one (even with the same outcome), or only the candidate reached the scenario's `expected` outcome |
| `regression` | The candidate broke a rule or threw, or they differ for any other reason                                                                              |

- Parity is outcome-level: the terminal outcome and the effects in the world. It does not compare tool-call order, because a machine usually reorders steps.
- `violations` come from ground truth, such as a ledger the world checks after the fact. A port that blocks a rule the loop broke is labeled `intended`, not a regression, so the machine is never pushed to copy the loop's bugs.
- Put every write the world records in `effects`, not only the main one. A refund issued without its approval looks the same as a correct one if `effects` holds only the refunds.
- A run that throws is recorded with outcome `'threw'` and its message as `detail`.
- Parity holds for these scenarios and these runs. With a live model, run it more than once, or drive both sides with the same deterministic stand-in model.

## Suite coverage

`traceCoverage` (from `@statelyai/agent/testing`) reports which states and handlers no trace exercised, so a suite can say how much of the machine it covers.

```ts no-check
import { explorePaths, traceCoverage } from "@statelyai/agent/testing";

const report = traceCoverage(machine, traces, {
  reachable: await explorePaths(machine, { input }),
});
report.unvisitedStates; // ["refunded"]
report.unvisitedHandlers; // [{ state: "deciding", event: "AUTO_APPROVE" }]
report.ratio; // { states: 0.75, handlers: 0.8 }
report.handlers[0];
// { state: "deciding", event: "AUTO_APPROVE", runs: 0, targets: { declared: ["refunded"], seen: [], unreached: ["refunded"] } }
```

- `states` lists every atomic and final state, in document order, with the number of runs that visited it. Compound, parallel, choice, and history states are not listed; their leaves are.
- A **handler** is a state and an event descriptor it declares: an `on` key, or the invoke and `after` handlers, which XState keys by bare type (`xstate.done.actor`, `xstate.error.actor`, `xstate.after`), one per state however many invokes it has. The machine root's handlers have `state: ""`.
- A step credits one handler per active leaf: the nearest state, from the leaf up, whose descriptor matches the event. Exact descriptors come first, then partial (`task.*`) and wildcard (`*`) ones, longest first, as XState orders them. A done or error event credits a state only when its invoke's id matches the event's. Guards are not replayed, so a step whose nearest handler a guard rejected is credited to that handler anyway.
- `targets.declared` lists the targets of a handler's object transitions, or is `"dynamic"` when any is a function transition. `targets.seen` lists the active states after the steps credited to it. `targets.unreached` lists declared targets no run landed in.
- `always` handlers are listed in `unobservable`, never as unvisited. A trace records one step per macrostep, so an eventless transition inside one does not show.
- `reachable` takes an `explorePaths` report. When the report explored every path (no cap hit, every payload expanded, no branch stopped early), states it never reached and no trace visited are listed in `unreachable` and leave the state denominator, so `ratio.states` counts only states a run could visit. `reachableComplete` says whether it did. A partial report narrows nothing: `unreachable` is absent and every state stays in the denominator.
- `ratio` is visited over total, for states and for handlers. It is 1 when the total is 0.
- Ignored steps credit no handler. Traces may be live or serialized, and a trace may span several resumed passes.

## Where failures start

`firstDivergence` (from `@statelyai/agent/testing`) finds the first step where a run departs from a reference, and names the state the run was in.

```ts no-check
import { firstDivergence, foldTraces } from "@statelyai/agent/testing";

firstDivergence(failingTrace, passingTrace);
// { index: 0, state: "deciding", decision: "chooseResolution", actual: { event: "escalate", … }, expected: { event: "refund", … } }

const stats = foldTraces(traces, {
  failed,
  blame: (trace) => firstDivergence(trace, passingTraceFor(trace))?.state,
});
// [{ state: "deciding", failures: 2, blamed: 2, … }, { state: "escalated", failures: 2, blamed: 0, … }]
```

- The reference is a trace, such as a passing run of the same scenario, or an expected trajectory (`TrajectoryItem[]`, as for `matchesTrajectory`).
- Against a trace, steps are compared in order. A step is one `machine.transition`: the active states before it, the event type, and the active states after it. The first step that differs is the divergence, and so is the point where either trace ends early.
- Against a trajectory, the run is laid out as its initial state, then each step's event and new state. The first expected item the run never reaches is the divergence, blamed on the step after the last item it did reach. A run that goes on past the trajectory has not diverged.
- `state` is the first active state before the diverging step. `decision` is the name of the decision request that chose that step's event, when one did. A different output from a text request is blamed on the state that invoked it.
- Steps the machine ignored are left out on both sides. `@xstate.init` is not a step.
- `key` projects a step to the string traces are compared by. The default is `from|event|to`. Override it to leave out a region that may differ between equivalent runs. Steps are still compared in order, so two runs whose parallel regions settle in a different order diverge.
- An empty reference is a trace with no steps, so the run's first step diverges from it.
- Returns `undefined` when the run does not diverge.
- In `foldTraces`, `blame` is called for failed runs only. `undefined` blames no state.

## Repeated runs

`repeatRuns` (from `@statelyai/agent/testing`) runs every scenario `k` times and reports how reliably each one passes. With a live model, one run per scenario says little: τ-bench found the rate at which all `k` runs of a task pass (pass^k) falls well below the single-run rate.

```ts no-check
import { repeatRuns } from "@statelyai/agent/testing";

const report = await repeatRuns({
  scenarios, // [{ id, ...your fields }]
  k: 5,
  run: async (scenario, attempt) => {
    const trace: AgentTraceEvent[] = [];
    const result = await runToQuiescence(
      createAgentRuntime(machine, { executors, onTrace: (event) => trace.push(event) }),
      { input: scenario.input },
    );
    return { trace, outcome: String(result.snapshot.value) };
  },
  passed: (scenario, { outcome }) => outcome === scenario.expected,
});

report.scenarios[0];
// { id: "duplicate-charge", passes: 3, passAny: true, passAll: false, distinctPaths: 2, divergedAt: "deciding", runs: [...] }
report.passHat(1); // the single-run pass rate
report.passHat(5); // the chance 5 runs of a scenario all pass
```

- `passAny` is pass@k for the scenario, and `passAll` is pass^k.
- `passHat(j)` estimates the suite's pass^j without running more: per scenario, C(passes, j) / C(runs, j), averaged over scenarios. Scenarios with fewer than `j` runs are left out. A `j` that is not a whole number from 1 to the most runs any scenario has throws an `AgentError` with code `pass-hat-out-of-range`.
- `distinctPaths` counts the different step sequences the runs took. `divergedAt` is the earliest state where a run left the first run's path, found with `firstDivergence`. A scenario that passes 3 of 5 runs and diverges at `deciding` points at one decision.
- Runs are sequential, scenario by scenario. A run that throws fails, with its message as `error` and no trace.
- `report.traces` holds every recorded trace, ready for `foldTraces` or `traceCoverage`.
- `k` below 1 throws an `AgentError` with code `invalid-repeat-count`.

For runs collected elsewhere, such as CI shards or production replays, `summarizeRepeats` takes the runs per scenario and returns the same report. `repeatRuns` collects runs and calls it.

```ts no-check
import { summarizeRepeats } from "@statelyai/agent/testing";

const report = summarizeRepeats([
  {
    id: "duplicate-charge",
    scenario,
    runs: [
      { passed: true, trace },
      { passed: false, trace: other },
    ],
  },
]);
```

## Judge agreement

`judgeAgreement` (from `@statelyai/agent/testing`) measures how well a judge agrees with people on the same cases. Check it before a judge-graded eval gates anything.

```ts no-check
import { judgeAgreement } from "@statelyai/agent/testing";

const report = judgeAgreement(
  confirmed.map((row) => ({
    id: row.id,
    human: row.label,
    judge: verdicts[row.id],
    group: row.state,
  })),
  { positive: "fail" },
);
report.accuracy; // 0.92
report.binary; // { tpr: 0.8, tnr: 0.95 }
report.perLabel; // { fail: { human: 10, agreed: 8 }, pass: { human: 40, agreed: 38 } }
report.correct?.(0.3); // the estimated true share of failures where the judge flagged 30%
report.groups?.deciding; // the same numbers for one decision state
```

- A row is `{ id, human, judge, group? }`. Build rows from confirmed labels only.
- The report has `total`, `accuracy`, `perLabel` (rows per human label, and how many the judge matched), `confusion` (counts by human label, then judge label), and `disagreements` in input order.
- `positive` names the positive label, and every other label is negative. It adds `binary`, the true positive rate and true negative rate. For a binary judge, these two rates say more than accuracy: they say which way the judge errs. A rate is `undefined` when no row has that human label.
- `correct(p)` turns the share `p` the judge labels positive on unlabeled runs into an estimate of the true share: (p + TNR − 1) / (TPR + TNR − 1), clamped to 0..1. It is omitted when either rate is `undefined`, or when TPR + TNR ≤ 1, where the judge is no better than chance.
- `groups` holds the same numbers per group, present when any row has a `group` or `groupBy` is given. `groupBy` overrides `row.group`. Group by decision state or request name, so each narrow judge is aligned on its own. A row with no group counts in the totals and in no group.
- Run it on a dev split, and report the held-out split separately.
- Empty `rows` throws an `AgentError` with code `empty-agreement-rows`.

## Verification

`simulateAgent`, `explorePaths`, `canReach`, and `matchesTrajectory` operate on the machine artifact. Unknown state targets and empty expected trajectories fail loudly instead of producing misleading successful scores.
