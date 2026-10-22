---
name: add-traces
description: Make every run of a @statelyai/agent or XState machine leave a replayable, stamped trace — an event log thread plus trace events — so evals and self-improvement can read what happened and what produced it. Use when asked to "add tracing", "add logging", "persist runs", "stamp traces", "record what the agent did", or "set up observability" for an agent machine, or before writing evals or improving a policy from traces.
---

# Add traces to an agent machine

Every run should leave two records, both stamped with what produced it:

| Record           | What it is                                                                     | Read by                                              |
| ---------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------- |
| Event log thread | The external inputs the machine consumed, in order. The source of truth        | `replay`, `getDecisionAttempts`, `getUsageFromEvents` |
| Trace events     | Observations: transitions with `from`, decision requests with offered options  | `foldTraces`, OpenTelemetry, debugging               |

```
version the machines → pick a store → name threads → stamp → collect trace events → prove replay → hand back
```

This is step 2 of 4. Before: `loop-to-machine`. Next: `add-evals`, then `improve-machine`.

## Hard rules

- **Traces never change behavior.** Recording is an observer. No branch reads a trace. An `onTrace` or `onTransition` handler that throws is reported with `console.error` and skipped. The store is different: it is write-ahead, so a failed write stops the run with `cause: "journal"`. Ask the user whether a run should fail when its log cannot be written (the store) or carry on unrecorded (record from `onEvent` instead).
- **A trace must name what produced it.** A run with no machine version or policy version cannot be used to compare versions, so it is useless to the improver.
- **Replay is the test.** A log that does not replay to the run's final state with zero model calls is not a trace yet.
- **No secrets or personal data in metadata or thread ids.** Use ids, not names or emails. The log itself holds the machine's input and every event verbatim (a ticket's text, a customer's reply), and trace snapshots hold the context: in production, redact or encrypt them per your data rules, and ask the user which applies.

## 1. Version the machines

Declare `version` on every machine whose runs you record: the environment and, if there is one, the policy machine.

```ts
export const deskMachine = deskSetup.createMachine({ id: "refund-desk", version: "1", ... });
```

Also name the **decider version**: whatever produces the model's answers. It is the policy machine's `version` when there is one. Otherwise it is a label for the model, its settings, and its prompts (`gpt-6-luna.xhigh.p<hash of the prompts>`); this holds for a machine with only text requests too. In tests it is the stand-in model's name (`careful`). Runs by different deciders must never share a label.

- Every log entry carries `machineVersion`. Without a declared `version` it falls back to a structural hash that skips functions, and in XState v6 the guards and targets live in transition functions. Changing a guard would not change the hash.
- Bump `version` on every behavior change. Adding recording is not one: it only observes. `improve-machine` bumps the policy's on promotion.
- A test-only variant built from the same factory (a loosened guard) gets its own `version` (`"1-loose"`), so its runs are never mistaken for the real machine's.

## 2. Pick a store

- **Tests and local runs:** `createInMemoryEventLogStore()` from `@statelyai/agent/log`, or write each thread's `result.events` to a JSON file after the run.
- **Production:** implement `AgentEventLogStore` against your database and check it with `assertEventLogStoreConformance`. Implement the optional `listThreads` so a split can be paged by prefix.

Pass it with a `threadId`. The store is write-ahead: no model call starts until the entries before it are durable.

```ts
const result = await runAgent(deskMachine, { input, executors, store, threadId, metadata });
await result.drain(); // late usage entries, before you read the store or exit
```

**A thread that already has entries is resumed, not overwritten.** Give every new run a new thread id; reuse one only to continue that run. Passing different `input` to a thread that already has entries throws `thread-input-mismatch` instead of handing back another run's result.

For a production store, use a table of its own (`threadId`, `index`, the entry as JSON, a unique key on both), not a table that already means something else, such as a usage counter.

## 3. Name threads

A thread id is how runs are found later. Use a prefix scheme and keep it in one function:

| Runs                     | Thread id                                    |
| ------------------------ | -------------------------------------------- |
| Scenario runs for evals  | `<split>:<deciderVersion>:<scenarioId>:r<k>`, `k` = the repeat index |
| Production               | `prod:<domain id>` (ticket id, session id)   |

`store.listThreads?.({ prefix: "train:careful:" })` then pages through one split of one decider. `listThreads` is optional on a custom store.

## 4. Stamp each run

`metadata` lands on the log's first (`@agent.init`) entry. Put there everything needed to tell two runs' producers apart:

```ts
const metadata = {
  environmentVersion: deskMachine.version ?? "unversioned",
  deciderVersion, // see step 1
  models: { decider: "openai/gpt-6-luna" }, // the machine's model refs → what the host resolved them to
  scenario: scenario.id, // eval runs only
  split: scenario.split, // eval runs only
};
```

Read it back with `entries[0].metadata`. It also holds `executionId` (and `migratedFrom` after a version bridge), which the library adds and reserves, so compare with `toMatchObject`, not `toEqual`. A resumed run keeps the stamp of the run that started the log. Type the stamp as `Record<string, JsonValue>` (`JsonValue` from `@statelyai/agent/log`); an interface without an index signature does not fit.

## 5. Collect trace events

`onTrace` sees every trace event. Serialize and keep them per thread:

```ts
import { serializeTraceEvent, type JsonSerializableTraceEvent } from "@statelyai/agent";

const trace: JsonSerializableTraceEvent[] = [];
const result = await runAgent(deskMachine, { ..., onTrace: (event) => trace.push(serializeTraceEvent(event)) });
await result.drain();

// For local batches: one file per thread. Encoding keeps colons and path separators out of the name.
const file = encodeURIComponent(threadId);
await mkdir("runs", { recursive: true });
await writeFile(`runs/${file}.events.json`, JSON.stringify(result.events));
await writeFile(`runs/${file}.trace.json`, JSON.stringify(trace));
```

Decide with the user whether `runs/` is committed or gitignored.

- In production, send them to OpenTelemetry: `createOtelTraceHandler({ tracer })` from `@statelyai/agent/otel` is an `onTrace` handler. It needs the optional peer `@opentelemetry/api`; without OpenTelemetry in the app, write the serialized events next to the log instead.
- **A policy run inside a decider** is a separate run. Pass it the same `onTrace` (and its own `store` thread, `<threadId>:policy:<n>`) if you want per-state stats for the policy too.
- **A plain XState machine** (built with `createMachine` or `setup`, decided with `decideNext`): drive it with `createAgentRuntime` and `runToQuiescence`, which accept plain machines, and pass each `decideNext` result as `{ event, attempts }` so refused choices reach the log. Push `{ type: "request.start", request: result.request }` onto the trace before sending the event, since a host-driven decision emits no trace itself.
- **A plain `createActor` run you cannot change:** attach `recordLog(actor)` from `@statelyai/agent/log` before `actor.start()`, and pass `inspect: traceTransitions((event) => trace.push(serializeTraceEvent(event)))` to `createActor`. `recordLog` cannot record decision attempts.

## 6. Prove it

Write these tests, with the stand-in model from `loop-to-machine`:

```ts
import { getDecisionAttempts, replay } from "@statelyai/agent/log";
import { foldTraces } from "@statelyai/agent/testing";

test("a recorded run replays to its final state with no model calls", async () => {
  const result = await runAgent(deskMachine, { input, executors, store, threadId: "test:careful:small-clean:r1", metadata });
  await result.drain();
  const entries = await store.read("test:careful:small-clean:r1");
  expect(entries.length).toBeGreaterThan(1); // a log was written at all
  const { snapshot } = replay(deskMachine, entries, { verify: "strict" }); // a pure fold: nothing runs
  // Compare more than the state value: context and output catch a field the log does not keep.
  expect({ status: snapshot.status, value: snapshot.value, context: snapshot.context, output: snapshot.output }).toEqual({
    status: result.snapshot.status,
    value: result.snapshot.value,
    context: result.snapshot.context,
    output: result.snapshot.output,
  });
  expect(entries[0]!.metadata).toMatchObject({ environmentVersion: "1" });
});
```

`verify: "strict"` proves the log was not altered: every entry's hash matches the fold. It does not prove the fold matches the live run, which is why the test compares the snapshots too. A journaled error replays as an `Error` with its `name`, `message`, and a string or number `code`; any other property of the thrown value is not kept.

- `foldTraces(traces, { failed })` over a batch returns a row for every state a run rested in. A `choice` state the run passes through in the same step gets no row. `failed` judges one whole trace; start with "the last event is not a `run.end` with status `done`, or the run ended in a failure or sentinel state", and ask the user whether a wrong outcome counts too. `withheld` is above 0 only for a closed choice (`payloads`), where the guards refused an option.
- `getDecisionAttempts(entries)` lists the refused choices of a run; for a machine with no decisions (`agent.decide` or `decideNext`) it is always empty, so skip this test. A stand-in model that picks from the offered options can never propose an illegal one, so write a raw decide executor for this test that proposes a refused event first: `decide: async (request) => ({ event: request.attempts.length ? request.options![0]!.event : { type: "REFUND", amount: 1000 } })`.
- Running a scenario with and without recording leaves the same world, the same model calls, and the same final state, and the recorded run's log is not empty.

## 7. Hand back

1. Where runs are stored and how thread ids are built.
2. The stamp fields.
3. Where trace events go.
4. The replay test passing.
5. Next step: `add-evals`.
