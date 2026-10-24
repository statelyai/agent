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
// [{ state: "deciding", visits: 2, failures: 1, withheld: 2, ignored: 0 }, ...]
```

- A trace is one run's events, live or from `serializeTraceEvent`. `failed` judges the whole trace.
- A run visits each state in a `machine.transition`'s `from.value` and `snapshot.value`. Nested states are dot-joined paths; a parallel state counts once per active leaf.
- `withheld` comes from a decision's first `request.start`: the length of `request.withheld`, counted toward the state the run was in, which is the `from.value` of the transition the choice causes.
- `ignored` counts `machine.transition` events with `ignored: true`: a host event the state had no transition for, counted toward that state.
- `decideNext` called by the host emits no trace. Push its request onto the trace before sending the event: `trace.push({ type: "request.start", request: result.request })`.
- Rows come in the order states were first seen. Sort them yourself, for example by `failures / visits`.

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

## Verification

`simulateAgent`, `explorePaths`, `canReach`, and `matchesTrajectory` operate on the machine artifact. Unknown state targets and empty expected trajectories fail loudly instead of producing misleading successful scores.
