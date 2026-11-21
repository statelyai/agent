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

- Each effect is an async function. A wrapped or recorded effect returns a Promise even when the original returns an async iterable at once: write `yield* await effects.stream()`.
- A call made around `effects` (a module-level client, `fetch`) is invisible to the machine, to traces, and to recordings. Move it into `effects` first.
- Keep effect arguments and results JSON-shaped where you can: they are journaled and recorded. Pass live objects (a chat session, an `AbortSignal`) by closure, not as arguments.
- An effect whose natural result is a live object (an agent instance) returns its name or id instead. The function that starts the run keeps a `Map` from id to object, created per run. See [Live objects](#live-objects).
- An effect that writes host state by reference (a tool mutating a shared `state` object) returns the change instead, and the wrapper applies it.
- A synchronous host callback (a stop predicate) or a diagnostic logger is not an effect. The workflow or the machine factory closes over it.

### Class-shaped code

When the loop is a class method that calls its own private methods for the model and the tools, there is no `(input, effects)` function to pass. Wrap it with no edit to the class (a phase in the middle of a method is extracted at step 0, see [A phase in the middle of a method](#a-phase-in-the-middle-of-a-method)):

- `run: (input, effects) => { const executor = createExecutor(input); executor.callModel = (...args) => effects.callModel(...args); return executor.run(); }`, with each effect calling the original method.
- One wrapped workflow serves every instance: the instance goes in as `live`, and the workflow reads it from its context. `run: (input, effects, { live }: { live: Agent }) => live.run(input)`, then `step0.run(input, { live: agent, effects })`. With `live` typed, every `run` call must pass it.
- Route the old test suite through the wrap with a factory or a static `create` stand-in, not a subclass, when the constructor is private.
- Install each replacement with `Object.defineProperty` (non-enumerable). A plain assignment adds an own enumerable field, which the repo's state snapshots then serialize.
- The seam is on both sides of `checkParity`: `before` runs the class with the seam installed, so a serialization bug in the seam shows up on both sides and parity reports equivalent. Also compare the untouched class against the port by output, with no seam on the original, and add scenarios for edge results: empty, `null`, non-JSON values, `BigInt`.

### Seams for other shapes

| Shape                                                                                             | Seam                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Effect-TS generator                                                                               | Transliterate the generator to async, statement for statement, and bridge each effect from Effect to Promise, keeping the fiber context, typed failures, and interrupts. The parity baseline is the async transliteration; the old suite covers the original.                                                                                                  |
| Redux thunk                                                                                       | The thunk's `extra` argument plus its nested dispatches. Wrap `dispatch` so every nested thunk gets the effects-backed `extra`.                                                                                                                                                                                                                                |
| LangGraph graph                                                                                   | Wrap `graph.invoke`. Fake the model factory with the test runner's module mock (`vi.mock`); the fake calls the run's effects.                                                                                                                                                                                                                                  |
| A closure inside a DI or Layer factory                                                            | Copy the module, identical outside the carved function, and swap it in with a module mock.                                                                                                                                                                                                                                                                     |
| Async generator the consumer pulls (yields events, `.return()` on break, `.throw()` to interrupt) | Step 0: wrap the host call that drains the generator, with the collected events as the output. Carve: the machine runs the loop head and each pass is an actor. Write the pull loop by hand: the original generator starts the run and yields each value a pass hands over, one per consumer pull, and forwards `.throw()` and `.return()` to the legacy pass. |
| A step loop inside the model SDK (`stopWhen`, `maxSteps`)                                         | No loop to carve. The SDK call stays one effect; carve the control flow around it, such as handoff or approval.                                                                                                                                                                                                                                                |

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

| Option     | Purpose                                                                                       |
| ---------- | --------------------------------------------------------------------------------------------- |
| `effects`  | Replaces some effects for one run: fakes, stubs, replay stand-ins                             |
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

### Live objects

A store, a class instance, a session or a cancellation token cannot go in context, input or events: those are journaled JSON. Bind the actors and actions that need them per run, as closures, in the function that starts the run.

```ts no-check
const machine = setupAgent({
  // ...schemas
  actions: { setStatus: (_params: { status: string }) => {} }, // default for tests and explorePaths
  actors: { think: createAsyncLogic({ run: async () => ({ kind: "final" }) }) },
}).createMachine({
  // ...
  entry: ({ actions }, enq) => enq(actions.setStatus, { status: "thinking" }),
});

async function agenticLoop(agent: Agent, task: Task) {
  return runAgent(machine, {
    input: { taskId: task.id },
    actions: { setStatus: ({ status }) => agent.store.setStatus(task, status) },
    actors: {
      think: createAsyncLogic({ run: () => legacy.executeThinking.call(agent, agent, task) }),
    },
  });
}
```

- `runAgent`'s `actions` and `actors` are merged onto the machine for that run only. Concurrent runs each see their own objects.
- `actions` keys and params are checked against the actions declared in `setupAgent`. Declare a no-op for each; it is the default for tests and `explorePaths`.
- Only actors and actions read live objects. A guard, a `choice` or a transition function that reads one makes a decision the log does not record, so replay, resume and `explorePaths` can reach another state. Copy what the machine branches on into an actor's output.
- An action runs through `enq(...)`, after the transition. A `{ context }` it returns is ignored.
- Resume binds the same way: the host builds the actors and actions again and passes them with the snapshot or `store`. Nothing about the live objects is journaled.
- An effect whose result is a live object (an agent instance) records an id. Keep the id-to-object `Map` in the same function, created per run, never at module level.

### A phase in the middle of a method

Extract the phase first, then carve. The carved actor calls the extracted method or function, and nothing is copied.

- The extract is a step 0 edit: move the loop body or the phase into its own method or function, with no change in behavior. In a class, make it a protected method when the carve is a subclass that builds its actors inside the class body (the drop-in runner the old suite swaps in). An actor built outside the class calls a public method instead, marked `@internal`. Either way the actor calls it on the instance, bound per run.
- Commit it on its own, before any carve, so the diff is a pure move.
- Gate it like step 0: the old suite passes unchanged, and `checkParity` against the code before the extract is equivalent on every scenario. `examples/strangler-fig/before-extract.ts` is the one-function original; `index.test.ts` checks the extracted `runTicket` against it.
- A loop whose head lives in a private method: extract the body (`this._cycle(state)`), so the loop head is the only line the carve replaces.
- When the class has a public per-turn hook, replace that method on the instance instead, and let the machine decide at that boundary. The rest of the method stays legacy.

#### Code you can't edit

For vendored or third-party code (in `node_modules` or a pinned fork), copy only that phase's lines into the carved actor, with a comment listing the copied line ranges.

- `checkParity` call-args catch a drifted copy only when the drift changes an effect's arguments.
- Add a drift test that hashes each copied range in the original, so an upstream change fails CI:

```ts no-check
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const lines = readFileSync(require.resolve("vendor-lib/dist/runtime.js"), "utf8").split("\n");
const hash = (from: number, to: number) =>
  createHash("sha256")
    .update(lines.slice(from - 1, to).join("\n"))
    .digest("hex");

test("copied ranges match the original", () => {
  expect(hash(412, 470)).toBe("<sha256 recorded when you copied>");
});
```

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

| Field                          | Value                                                             |
| ------------------------------ | ----------------------------------------------------------------- |
| `report.equivalent`            | `true` when every scenario is                                     |
| `row.divergences`              | `compareRecordings` divergences: `call-args`, `missing-effect`, … |
| `row.before` / `row.after`     | `{ output }` or `{ error }`                                       |
| `row.recording` / `row.replay` | The baseline recording, and what `after` did in replay            |
| `report.scenarios`             | The rows, one per scenario, in order                              |

- An `after` that throws is a row with `after: { error }`, never a thrown `checkParity`. A call the recording cannot answer throws `RecordingDivergenceError` inside `after`.
- When both sides throw, they match on the error's name and message.
- Replay throws a recorded error with its name, message, number and boolean fields, `cause`, and an `AggregateError`'s `errors`. It is a plain `Error` or `AggregateError`. When the code branches on `instanceof`, pass `reviveError` to build its own class: `reviveError: (recorded) => recorded.name === "AbortError" ? new AbortError(recorded.message) : undefined`. A recorder takes the same option.
- An effect result that is not JSON (a class instance, a `Response`) records as its JSON and replays as a plain value. Pass `recordOptions: { lookupOrder: { serialize, revive } }` to `checkParity` or `wrapWorkflow().run` to keep the class in replay.
- `compare` passes options through to `compareRecordings`, such as `normalize` for generated ids.
- `setup: (scenario, side) => liveObject` builds what one side runs on (a class instance, a session). It is called once for `before` and once for `after`, and its result is the last argument of `effects`, `before` and `after`. Effects then bind to the object without a module-level slot, and a mutable object does not carry state from `before` into `after`.

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
- Old code that registers its in-flight call with a host registry synchronously (a store's tracked promises, a map of `AbortController`s), so that pause or stop can cancel it: register the run in the same tick, before calling `runAgent`, with a promise that settles when the run does, and pass the registry's signal as `signal`. An abort in the same tick as the `runAgent` call settles the run `aborted` before any actor starts. Otherwise a pause and resume that land before the run starts leave the first run going next to the resumed one.
- `runAgent` starts asynchronously. Fire-and-forget work the old code starts at the same time may settle in a different order. An old test that asserts the exact order of actions across concurrent tasks is a structural failure only when those actions commute and their order is not part of the contract; an order that reaches users or storage is behavioral.

## Repeat

Each carved phase adds what the machine can prove:

| Step | Change                        | Gained                                                             |
| ---- | ----------------------------- | ------------------------------------------------------------------ |
| 0    | none                          | transitions, traces, event log, `signal`, a recorded baseline      |
| 1    | classify retry becomes states | `canReach` proves the classifier runs at most `MAX_ATTEMPTS` times |
| n    | the last phase becomes states | the machine is the workflow; drop the wrapper                      |

The step 1 proof in `examples/strangler-fig/index.test.ts`:

```ts no-check
const tooMany = await canReach(
  supportMachine,
  (snapshot) => snapshot.context.attempts > MAX_ATTEMPTS,
  {
    input: ticket,
    outputs: { classify: [classification], resolve: [resolved] },
    errors: { classify: new Error("model overloaded") },
  },
);
// { reachable: false, complete: true }
```

Step 0 cannot give this proof: its one `running` state holds the whole function.

## Host writes outside the log

A host that writes to its own database during a run holds state the machine's log does not. When a run fails after such a write commits, the two disagree. In one conversion of a Cloudflare Durable Object agent, a run escalated a case in the database and then failed. The port did not store the machine state on the error path, so the stored snapshot said `open` while the database said `escalated`, and the next message called the model on a case a person owned.

### Reconcile on error

Give the machine a host event that moves it to the state matching the host's record. On an error result, read the record back, send the event to the snapshot stored before the failed run, and store the result.

```ts no-check
const caseSetup = setupAgent({
  context: z.object({ caseId: z.string() }),
  input: z.object({ caseId: z.string() }),
  events: {
    MESSAGE: z.object({ text: z.string() }),
    RESYNC: z.object({ status: z.enum(["open", "escalated"]) }),
  },
});

const caseMachine = caseSetup.createMachine({
  id: "case",
  version: "2", // RESYNC added
  context: ({ input }) => ({ caseId: input.caseId }),
  initial: "open",
  on: {
    RESYNC: ({ event }) => ({ target: event.status === "escalated" ? ".escalated" : ".open" }),
  },
  states: {
    open: {/* MESSAGE: to replying */},
    replying: {/* the model call and the host's writes */},
    escalated: {},
  },
});

async function onMessage(caseId: string, text: string) {
  let stored = await storage.get(`snapshot:${caseId}`);
  // A run or reconciliation that did not finish leaves the marker: reconcile
  // before any new message.
  if (await storage.get(`resync:${caseId}`)) {
    stored = await resync(caseId, stored);
  }
  // Write-ahead: mark the case before the run, so a run that commits host
  // writes and then fails at any point leaves the marker.
  await storage.put(`resync:${caseId}`, true);
  const result = await runAgent(caseMachine, {
    snapshot: stored,
    event: { type: "MESSAGE", text },
    executors,
  });
  if (result.status !== "error") {
    await storage.put(`snapshot:${caseId}`, result.persist());
    await storage.delete(`resync:${caseId}`);
    return result;
  }
  await resync(caseId, stored);
  throw result.error;
}

async function resync(caseId: string, stored: unknown) {
  const { status } = await db.readCase(caseId);
  const resynced = await runAgent(caseMachine, {
    snapshot: stored,
    event: { type: "RESYNC", status },
    executors,
  });
  // A failed RESYNC keeps the marker for the next message to retry.
  if (resynced.status === "error") throw resynced.error;
  const snapshot = resynced.persist();
  await storage.put(`snapshot:${caseId}`, snapshot);
  await storage.delete(`resync:${caseId}`);
  return snapshot;
}
```

- `RESYNC` is handled on the root, so every state accepts it. Its payload is the host's record, read back after the failure, and the transition maps it to a state with no other logic.
- No message runs against a case until its reconciliation completes. The `resync:` marker is written before the run and deleted only after a snapshot is stored, so a run, `db.readCase`, or `storage.put` that fails at any point leaves the marker, and the next message reconciles first. If that reconciliation fails too, `onMessage` throws before any model call.
- Messages for one case must run one at a time, or a second message can read the snapshot before the first one's marker is written. Hold a per-case lock around `onMessage`, such as a promise chain kept on the Durable Object: a Durable Object delivers the next request while a run awaits a model call.
- Send it to the snapshot stored before the failed run. A snapshot of the error result stays in `error`: a resume from it settles `error` again.
- Store a snapshot on every settle path. A port that stores only on success keeps the state from before the failure.
- Adding `RESYNC` changes the machine, so bump `version`. XState requires an `id` on a machine with a `version`. See [Version bridge](persistence.md#version-bridge) for snapshots stored under the old version.

### Inline writes

When the existing class writes to its database inline (dozens of SQL or scheduler calls across its methods), routing every write through one `effects` object is impractical, and `checkParity` cannot see the writes. Take the extract path instead:

- Extract each phase into its own method, one commit per extract, with the old suite passing after each. See [A phase in the middle of a method](#a-phase-in-the-middle-of-a-method).
- Compare the old class and the port with `compareRuns` (from `@statelyai/agent/testing`) over world-state snapshots: each side runs a scenario against a fresh database and returns what the database holds afterward as `effects`.

```ts no-check
import { compareRuns } from "@statelyai/agent/testing";

async function runAgainstDatabase(run: typeof runOldAgent, scenario: Scenario) {
  const db = createTestDatabase();
  try {
    const outcome = await run(db, scenario);
    return { outcome, effects: db.dumpTables() };
  } catch {
    // A run that throws can still have committed writes: compare them too.
    return { outcome: "threw", effects: db.dumpTables() };
  }
}

const report = await compareRuns({
  scenarios, // [{ id, expected?, ...your fields }]
  baseline: (scenario) => runAgainstDatabase(runOldAgent, scenario),
  candidate: (scenario) => runAgainstDatabase(runPortedAgent, scenario),
});
expect(report.ok).toBe(true); // no regressions
```

- `effects` is compared structurally. Sort rows whose order does not matter.
- Read the database on the throw path too. A run that throws after a write commits is the case the [reconcile](#reconcile-on-error) step exists for, and `outcome: "threw"` with no `effects` would hide that write.
- Include every table the agent writes, scheduled alarms included. A write left out of `effects` is not compared.
- See [Outcome labels](evals.md#outcome-labels) for how each difference is labeled.

## Limits

- A wrapped workflow is a black box. The machine has one state for all of it.
- No resume in the middle of the function. A resumed run starts the workflow again.
- `canReach` and `explorePaths` prove nothing about the wrapped function's inside.
- Effect arguments and results are journaled JSON-safe. A value that is not JSON (a class instance) loses what JSON cannot hold. A stream is journaled as the chunks read through `for await` or `next()`; one read another way (a `ReadableStream` reader) never settles its effect.
- Parity cannot see an effect that mutates host state by reference, or one whose result is a live object. Return a change, a name, or an id, and keep a per-run map from id to object.
- `checkParity` runs `before` on the effects you give it for real. Give it fakes or an isolated fixture, never production writes.
- `effects` are async functions only. A sync function or a client object goes behind an async function first.
- Parity covers what goes through `effects` and the output. A change in a call made around `effects` is not seen.

## Related

- [Migrating from a hand-rolled loop](from-a-loop.md): port a whole loop at once.
- [Evals](evals.md#parity-with-the-code-you-replace): which of `checkParity`, `createRecorder` with `compareRecordings`, and `compareRuns` fits the code you replace.
- [Verify](verify.md): `canReach` and `explorePaths`.
- [`loop-to-machine`](https://github.com/statelyai/skills/blob/main/plugins/stately-agent/skills/loop-to-machine/SKILL.md): the retrofit, run by a coding agent.
