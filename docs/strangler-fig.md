---
title: Strangler-fig retrofit
description: Wrap an existing async workflow as a machine with no rewrite, record a baseline, then move one phase at a time into states with a parity check after each.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

A strangler-fig retrofit moves an existing workflow onto a machine without a rewrite. Step 0 wraps the function unchanged. Each later step moves one phase into states and checks the result against the original with `checkParity`.

- Step 0 takes minutes: inspection, traces, the event log, `signal`, and a recorded baseline, with no change to the workflow.
- Reliability proofs (`canReach`, `explorePaths`) arrive per phase, as each phase becomes states.
- [Migrating from a hand-rolled loop](from-a-loop.md) is the other path: port the whole loop at once.

The code on this page is in [`examples/strangler-fig`](https://github.com/statelyai/agent/blob/next/examples/strangler-fig).

## The workflow's one requirement

The workflow reaches the outside world only through an `effects` object: model calls, tools, reads, and writes.

```ts no-check
export async function runTicket(ticket: Ticket, effects: SupportEffects): Promise<SupportResult> {
  const classification = await classifyTicket(ticket, effects); // retries effects.generate
  return resolveTicket(ticket, classification, effects); // lookupOrder, issueRefund, escalate
}
```

- Each effect is an async function.
- A call made around `effects` (a module-level client, `fetch`) is invisible to the machine, to traces, and to recordings. Move it into `effects` first.
- Keep effect arguments and results JSON-shaped where you can: they are journaled and recorded. Pass live objects (a chat session, an `AbortSignal`) by closure, not as arguments.
- An effect whose natural result is a live object (an agent instance) returns its name or id instead. The host keeps a registry from id to object.
- An effect that writes host state by reference (a tool mutating a shared `state` object) returns the change instead, and the wrapper applies it.
- A synchronous host callback (a stop predicate) or a diagnostic logger is not an effect. The workflow or the machine factory closes over it.

### Class-shaped code

When the loop is a class method that calls its own private methods for the model and the tools, there is no `(input, effects)` function to pass. Wrap it with no edit to the class:

- `run: (input, effects) => { const executor = createExecutor(input); executor.callModel = (...args) => effects.callModel(...args); return executor.run(); }`, with each effect calling the original method.
- Route the old test suite through the wrap with a factory or a static `create` stand-in, not a subclass, when the constructor is private.

### Seams for other shapes

| Shape                                                     | Seam                                                                                                                                                                                                                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Effect-TS generator                                       | Transliterate the generator to async, statement for statement, and bridge each effect from Effect to Promise, keeping the fiber context, typed failures, and interrupts. The parity baseline is the async transliteration; the old suite covers the original. |
| Redux thunk                                               | The thunk's `extra` argument plus its nested dispatches. Wrap `dispatch` so every nested thunk gets the effects-backed `extra`.                                                                                                                               |
| LangGraph graph                                           | Wrap `graph.invoke`. Fake the model factory with the test runner's module mock (`vi.mock`); the fake calls the run's effects.                                                                                                                                 |
| A closure inside a DI or Layer factory                    | Copy the module, identical outside the carved function, and swap it in with a module mock.                                                                                                                                                                    |
| A step loop inside the model SDK (`stopWhen`, `maxSteps`) | No loop to carve. The SDK call stays one effect; carve the control flow around it, such as handoff or approval.                                                                                                                                               |

## Step 0: wrap

`wrapWorkflow` turns the function into a machine. The function runs unchanged.

```ts
import { wrapWorkflow } from "@statelyai/agent";

interface Ticket {
  id: string;
  message: string;
}

const effects = {
  lookupOrder: async (orderId: string) => ({ orderId, total: 20 }),
  // Keyed, so a retried or resumed run cannot refund twice.
  issueRefund: async (orderId: string, amount: number, idempotencyKey: string) => ({
    refundId: `rf_${orderId}`,
  }),
};

async function runTicket(ticket: Ticket, fx: typeof effects) {
  const order = await fx.lookupOrder(ticket.id);
  return fx.issueRefund(order.orderId, order.total, `refund:${ticket.id}`);
}

const support = wrapWorkflow({
  id: "support",
  effects,
  run: (ticket: Ticket, fx) => runTicket(ticket, fx),
});

const result = await support.run({ id: "A-100", message: "Refund my mug." });
// result: { refundId: "rf_A-100" }, what runTicket returned
```

- `support.run(input, options)` resolves with what the workflow returned and rethrows what it threw, the same error object.
- `support.machine` is an ordinary agent machine: `running` invokes the workflow, `done` is final with its result as output. It works with `runAgent`, `describeMachine`, `canReach`, and the inspector.
- A thrown error settles `runAgent(support.machine, …)` as `{ status: "error", cause: "machine" }`.
- `options.signal` reaches the workflow as the `run` callback's third argument, `{ signal }`. The workflow decides what an abort returns, as it did before: one that returns an `aborted` result still returns it.

### Effect calls as events

Each effect call is two events, `effect.call` then `effect.done` or `effect.error`, handled in `running`:

| Event          | Payload                  | Context                |
| -------------- | ------------------------ | ---------------------- |
| `effect.call`  | `name`, `call`, `args`   | `calls` goes up by one |
| `effect.done`  | `name`, `call`, `result` | unchanged              |
| `effect.error` | `name`, `call`, `error`  | `failures` goes up     |

- `call` is the 0-based call number across the run; it pairs a call with its result.
- Payloads are JSON-safe, so they land in the event log and traces as they are. Pass `redact: (name, part, value) => …` to strip secrets and private records first; the workflow still gets the real values.
- Once the run's `signal` aborts, an effect throws the abort reason instead of running, even in a workflow that ignores its signal.
- `effects` can be a class instance: its prototype methods count, bound to it.
- `onTransition`, `onTrace`, `onEvent`, and `inspect` see every effect call.
- An effect that returns a stream settles once the stream is read: `effect.done` carries the chunks (`{ chunks, returned }` when a generator returned a value), and a throw mid-stream is `effect.error`.

### Run options

`support.run(input, options)` takes these `runAgent` options: `signal`, `inspect`, `onTransition`, `onTrace`, `onEvent`, `metadata`, and `verification`. Two more are its own:

| Option     | Purpose                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------- |
| `effects`  | Replaces some effects for one run: fakes, stubs, replay stand-ins                           |
| `recorder` | Wraps every effect with `recorder.fn(name, fn)` and records the result with `recorder.output` |

Effects bound to one call's live objects (a request context, a span) go in per call: create the workflow once and pass `run(input, { effects })` on every call. The `effects` given to `wrapWorkflow` are then the defaults.

## Record a baseline

A `recorder` on a normal run produces a golden recording of what the workflow did.

```ts
import { wrapWorkflow } from "@statelyai/agent";
import { createRecorder } from "@statelyai/agent/testing";

const support = wrapWorkflow({
  id: "support",
  effects: { lookupOrder: async (orderId: string) => ({ orderId, total: 20 }) },
  run: async (orderId: string, fx) => (await fx.lookupOrder(orderId)).total,
});

const recorder = createRecorder();
await support.run("A-100", { recorder });
recorder.recording.effects;
// [
//   { kind: "call", name: "lookupOrder", call: 0, args: ["A-100"], result: { orderId: "A-100", total: 20 } },
//   { kind: "output", value: 20 },
// ]
```

Save `recorder.recording` as a fixture. `createRecorder({ replay: recording })` answers each call from it with no effect running. See [Parity with the code you replace](evals.md#parity-with-the-code-you-replace).

## Carve one phase

A carved phase becomes states. The rest of the workflow stays a function, invoked as one actor. The runner keeps the `(input, effects)` signature.

In the example, `step1.ts` carves the classifier's retry loop:

```ts no-check
classifying: {
  invoke: {
    src: "classify", // effects.generate({ task: "classify", ... })
    input: ({ context }) => context.ticket,
    onDone: ({ context, output }) => ({
      target: "resolving",
      context: { attempts: context.attempts + 1, classification: output },
    }),
    onError: ({ context }) => ({ target: "retrying", context: { attempts: context.attempts + 1 } }),
  },
},
retrying: {
  type: "choice",
  choice: ({ context }) =>
    context.attempts < MAX_ATTEMPTS
      ? { target: "classifying" }
      : { target: "resolving", context: { classification: UNCLASSIFIED } },
},
resolving: {
  invoke: { src: "resolve", /* resolveTicket from before.ts, unchanged */ },
},
```

- Build the actors per run from `effects`, and pass them as `runAgent`'s `actors`.
- Give the runner a third `options` argument passed through to `runAgent` (`threadId`, `store`, `metadata`, `onTrace`, `inspect`). Traces and inspection then need no copy of it.
- Move prompt or warning text the carved phase sends into a versioned request config as you carve. That file is the lever `improve-machine` may edit later.
- Carve one phase per commit.
- A phase in the middle of a `try`/`finally`: the setup before it moves into the runner, and the `finally` becomes a state every exit passes through, so a proof can say cleanup runs first.
- A legacy body that owns abort (it returns its own `stopped` result): pass the `signal` to the legacy body only, not to `runAgent`. Its result then reaches the machine as a normal final; `runAgent`'s `signal` would settle the run as `aborted` instead.
- An invoke whose error must reach the caller unchanged: omit `onError`. The run settles `{ status: "error", error }` with the original error, and the runner rethrows it. Pass `disable: ["invoke-without-on-error"]` to `lintAgentMachine` for that machine, or `ignore: [{ code: "invoke-without-on-error", path }]` for one state.

### A phase in the middle of a method

- Copy only that phase's lines into the carved actor, with a comment listing the copied line ranges. `checkParity` call-args keep the copy honest: a drifted copy calls its effects with other arguments.
- When the class has a public per-turn hook, replace that method on the instance instead, and let the machine decide at that boundary. The rest of the method stays legacy.

## Check parity

`checkParity` from `@statelyai/agent/testing` checks a step against the original, scenario by scenario.

```ts
import { wrapWorkflow } from "@statelyai/agent";
import { checkParity } from "@statelyai/agent/testing";

const createEffects = () => ({
  lookupOrder: async (orderId: string) => ({ orderId, total: 20 }),
});

async function before(orderId: string, fx: ReturnType<typeof createEffects>) {
  return (await fx.lookupOrder(orderId)).total;
}

const step0 = wrapWorkflow({ id: "support", effects: createEffects(), run: before });

const report = await checkParity({
  scenarios: [{ id: "mug", input: "A-100" }],
  effects: () => createEffects(),
  before,
  after: (input, fx) => step0.run(input, { effects: fx }),
});
report.equivalent; // true
```

What it does per scenario:

1. Runs `before` on fresh `effects(scenario)`, each function wrapped with `recorder.fn`, and records the output.
2. Runs `after` on replay stand-ins: each call is answered from the recording, and no effect runs.
3. Compares the two recordings with `compareRecordings`: effect names, call order, arguments, results, and the output.

| Field                        | Value                                                                  |
| ---------------------------- | ---------------------------------------------------------------------- |
| `report.equivalent`          | `true` when every scenario is                                          |
| `row.divergences`            | `compareRecordings` divergences: `call-args`, `missing-effect`, …      |
| `row.before` / `row.after`   | `{ output }` or `{ error }`                                            |
| `row.recording` / `row.replay` | The baseline recording, and what `after` did in replay              |

- An `after` that throws is a row with `after: { error }`, never a thrown `checkParity`. A call the recording cannot answer throws `RecordingDivergenceError` inside `after`.
- When both sides throw, they match on the error's name and message.
- `compare` passes options through to `compareRecordings`, such as `normalize` for generated ids.

### Generated ids

Ids and timestamps differ on every run. Scrub them on both sides:

```ts
import { randomUUID } from "node:crypto";
import { wrapWorkflow } from "@statelyai/agent";
import { checkParity } from "@statelyai/agent/testing";

const createEffects = () => ({
  saveDraft: async (draft: { id: string; text: string }) => ({ saved: draft.id }),
});

async function before(text: string, fx: ReturnType<typeof createEffects>) {
  const id = randomUUID();
  if (!text) throw new Error(`Draft ${id} is empty`);
  await fx.saveDraft({ id, text });
  return { id, text };
}

const step0 = wrapWorkflow({ id: "drafts", effects: createEffects(), run: before });

const UUID = /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/g;
const scrub = <T>(value: T): T => JSON.parse(JSON.stringify(value).replace(UUID, "<id>"));

const report = await checkParity({
  scenarios: [
    { id: "saved", input: "Hello" },
    { id: "empty", input: "" },
  ],
  effects: () => createEffects(),
  before,
  after: (input, fx) => step0.run(input, { effects: fx }),
  compare: { normalize: scrub }, // effect arguments and results, and the recorded output
  normalizeOutput: scrub, // the output, before it is recorded
  normalizeError: (error) => String(error).replace(UUID, "<id>"), // thrown errors
});
report.equivalent; // true
```

- `compare.normalize` maps every recorded effect on both sides. Without it, `saved` diverges on `call-args`.
- `normalizeOutput` maps each side's output before it is recorded. Use it when the scrub is not on every effect, or for a value only the output carries.
- `normalizeError` maps each side's thrown error. Errors are compared outside the recording, so without it `empty` diverges on `output`.

### The old suite on the port

Run the module's own tests against the port by swapping the module.

- Snapshot files are named after the test file that runs them. A swap file that imports the old suite writes fresh snapshots on its first run, and `toMatchSnapshot` passes without comparing. Copy the old `__snapshots__/<old>.snap` to the swap file's name, and run with `CI=true` so a missing snapshot fails.
- A module mock whose factory imports the port deadlocks or recurses when the port imports the mocked module. Load the port with a dynamic import in `beforeAll`, and call it from inside the mocked functions.
- When a module mock does not reach the code's own import of the module (one runner did not apply it to a relative import inside the package), patch the class prototype from a setup file instead. Import both modules dynamically in its `beforeAll`: a static import loads the module before the test file's mocks apply.
- `runAgent` starts asynchronously. Fire-and-forget work the old code starts at the same time may settle in a different order. An old test that asserts the exact order of actions across concurrent tasks is a structural failure only when those actions commute and their order is not part of the contract; an order that reaches users or storage is behavioral.

## Repeat

Each carved phase adds what the machine can prove:

| Step | Change                         | Gained                                                          |
| ---- | ------------------------------ | --------------------------------------------------------------- |
| 0    | none                           | transitions, traces, event log, `signal`, a recorded baseline   |
| 1    | classify retry becomes states  | `canReach` proves the classifier runs at most `MAX_ATTEMPTS` times |
| n    | the last phase becomes states  | the machine is the workflow; drop the wrapper                   |

The step 1 proof in `examples/strangler-fig/index.test.ts`:

```ts no-check
const tooMany = await canReach(supportMachine, (snapshot) => snapshot.context.attempts > MAX_ATTEMPTS, {
  input: ticket,
  outputs: { classify: [classification], resolve: [resolved] },
  errors: { classify: new Error("model overloaded") },
});
// { reachable: false, complete: true }
```

Step 0 cannot give this proof: its one `running` state holds the whole function.

## Limits

- A wrapped workflow is a black box. The machine has one state for all of it.
- No resume in the middle of the function. A resumed run starts the workflow again.
- `canReach` and `explorePaths` prove nothing about the wrapped function's inside.
- Effect arguments and results are journaled JSON-safe. A value that is not JSON (a class instance) loses what JSON cannot hold. A stream is journaled as the chunks read through `for await` or `next()`; one read another way (a `ReadableStream` reader) never settles its effect.
- Parity cannot see an effect that mutates host state by reference, or one whose result is a live object. Return a change, a name, or an id, and keep a registry on the host side.
- `checkParity` runs `before` on the effects you give it for real. Give it fakes or an isolated fixture, never production writes.
- `effects` are async functions only. A sync function or a client object goes behind an async function first.
- Parity covers what goes through `effects` and the output. A change in a call made around `effects` is not seen.

## Related

- [Migrating from a hand-rolled loop](from-a-loop.md): port a whole loop at once.
- [Evals](evals.md#parity-with-the-code-you-replace): `createRecorder`, `compareRecordings`, and `compareRuns`.
- [Verify](verify.md): `canReach` and `explorePaths`.
- [`skills/loop-to-machine`](https://github.com/statelyai/agent/blob/next/skills/loop-to-machine/SKILL.md): the retrofit, run by a coding agent.
