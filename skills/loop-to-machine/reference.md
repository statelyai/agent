# Convert agent code to a machine: reference

Code and semantics behind [SKILL.md](SKILL.md). The rules are in the skill; this page is how.

## A gated action

An `agent.decide` with a closed choice, and the rule as a guard in the transition:

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
    ESCALATE: { target: "escalating" },
    CLOSE: { target: "closing" },
  },
},
```

## Proof options

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

`errors[src]` takes one failure or an array of them (one failing branch per element; wrap an array-valued failure as `[[...]]`), and `"agent.decide"` is a valid key.

## Recording golden runs

Wrap the model and tools, run the old code, save the recording. One recording per scenario and per stand-in. Record with the live model to capture real answers, or with a stand-in; either way the recording is the script for replay.

```ts
import { createRecorder } from "@statelyai/agent/testing";

const recorder = createRecorder();
const model = recorder.model(openai("gpt-5")); // or recorder.openai(new OpenAI())
const tools = recorder.tools(appTools); // AI SDK tools; recorder.tool(name, fn) for plain functions
recorder.output(await runLoop({ ...scenario, model, tools }));
writeFileSync(`fixtures/${scenario.id}.json`, JSON.stringify(recorder.recording));
```

### Any other model client

`recorder.client(name, sdk, { methods })` wraps the named async methods of an SDK object and keeps its type; `recorder.fn(name, asyncFn)` wraps a client that is a function. Record the hand-rolled loop with the wrapped client, then put the same wrapper inside the machine's executor for replay:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { runAgent } from "@statelyai/agent";
import { compareRecordings, createRecorder } from "@statelyai/agent/testing";

const methods = ["messages.create"];

// Record: the hand-rolled loop gets the wrapped client.
const recorder = createRecorder();
recorder.output(await runLoop(recorder.client("anthropic", new Anthropic(), { methods }), scenario));

// Replay: the same wrapper inside the machine's executor; the client is never called.
const replay = createRecorder({ replay: recorder.recording });
const client = replay.client("anthropic", {} as Anthropic, { methods });
const run = await runAgent(machine, {
  input: scenario,
  executors: {
    // askModel: the old loop's call, moved unchanged.
    generateText: async (request) => ({ result: await askModel(client, request.messages as Anthropic.MessageParam[]) }),
  },
});
if (run.status === "done") replay.output(run.output);
compareRecordings(recorder.recording, replay.recording).divergences; // INTENDED[scenario.id] ?? []
```

- Each call is a `call` effect named `<name>.<method>` (`anthropic.messages.create`) with its arguments and its result or error.
- Replay answers each call with the next unused recorded call of the same name, in order, whatever its arguments; `compareRecordings` reports differing arguments as `call-args`.
- A result that is an async iterable (a stream) records its chunks; replay returns an async iterable of them.
- `redact(args)` records only what must match (model, offered tool names) and keeps secrets out. `serialize` maps a non-JSON result or chunk; `revive` rebuilds the replayed value, such as a stream object with helper methods.

## The parity harness

Each run becomes a `ParityRun`: the outcome, every write the world records, and the rules broken. The harness check runs the old code on both sides:

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

The parity test switches the candidate to `runMachine`:

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

With no model in the loop, a spec baseline replaces the old code's run, and the candidate runs in a scripted world (the proposed calls, the order approvals arrive in, which tool fails):

```ts
// Confirmed by a person from the old code and its docs, before the machine existed.
const SPEC: Record<string, ParityRun> = {
  /* "two-calls-one-rejected": { outcome: "completed", effects: { executed: ["read"], rejected: ["write"] }, violations: [] }, */
};

const report = await compareRuns({
  scenarios: SCENARIOS,
  baseline: async (s) => SPEC[s.id]!,
  candidate: async (s) => toParityRun(await runMachine({ ...s, world: createScriptedWorld(s) })),
});
```

## Replay equivalence

Replay answers each model and tool call from the recording, so the machine needs no key and causes no side effects:

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

- Equivalent means the same model calls (count and shape: offered tool names, response format), the same tool calls with the same arguments, and the same output. Prompts and states may differ. Tool calls that ran at the same time compare in any order; sequential ones keep theirs.
- Values that differ on every run (generated ids, branch names, timestamps) fail `tool-input`. Pass the same `normalize` to `createRecorder({ replay, normalize })` and `compareRecordings(a, b, { normalize })` to redact them on both sides; never edit the fixtures. `normalize(effect, index, effects)` returns `undefined` to leave an effect out of `compareRecordings`, such as a repeat of an idempotent write; replay still answers from it. Drop an effect only when repeating it is harmless: a dropped `send` or `charge` hides a duplicate.
- `divergences` lists every difference, lined up so one extra call does not shift the rest; `divergence` is the first.
- Replay answers each model call with the earliest unused recorded call of the same method and shape, and each tool call with the earliest unused recorded call of the same name and input, not by position. A call the machine added or dropped does not shift the answers after it, as long as no other call has the same method and shape (or tool name and input). Calls that do are answered in recorded order, so an added or dropped one takes or leaves the next one's answer.
- A call no recorded answer fits throws `RecordingDivergenceError`, and `compareRecordings` names it. To run the machine's own path instead (its retry, its added check), pass `fallback: { model: standIn, tools: true }`: a stand-in model answers the call and the wrapped tool runs. Those effects are marked `unrecorded` and still count as extra.
- `model-call-shape`: the machine changed a call's tools or output format, for example a model-picked action that became `agent.decide`. Port the call unchanged first, prove equivalence, then change it in a separate step whose divergences are `INTENDED`. To keep replaying past a call you changed on purpose, pass `translate(recorded, actual)` to `createRecorder`: it returns the answer that fits the new call (`{ response }`, `{ stream }`, or `{ error }`), or `undefined` to leave that recorded call alone, and `compareRecordings` counts the pair as the same call. When the recorded answer already fits, a `modelCalls` function passed to both is enough: `(expected, actual) => expected.call === 2 || sameModelCallShape(expected, actual)`.
- When the machine asks the model a different way altogether (another protocol, one structured draft instead of a tool loop), compare what it did, not how it asked: `compareRecordings(a, b, { kinds: ["tool", "output"] })`, with the machine recorded on a stand-in model.
- A guard that blocks a rule break diverges on purpose. List it in `INTENDED` with the exact divergence.
