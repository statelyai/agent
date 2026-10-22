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

- **Traces never change behavior.** Recording is an observer. No branch reads a trace.
- **A trace must name what produced it.** A run with no machine version or policy version cannot be used to compare versions, so it is useless to the improver.
- **Replay is the test.** A log that does not replay to the run's final state with zero model calls is not a trace yet.
- **No secrets or personal data in metadata or thread ids.** Use ids, not names or emails. The log itself holds the machine's input and every event verbatim (a ticket's text, a customer's reply), and trace snapshots hold the context: in production, redact or encrypt them per your data rules, and ask the user which applies.

## 1. Version the machines

Declare `version` on every machine whose runs you record: the environment and, if there is one, the policy machine.

```ts
export const deskMachine = deskSetup.createMachine({ id: "refund-desk", version: "1", ... });
```

Also name the **decider version**: what answers the decisions. It is the policy machine's `version` when there is one; otherwise a label for the model and prompt that decide (`gpt-6-luna.p1`), or for a stand-in model in tests (`careful`). Runs by different deciders must never share a version label.

- Every log entry carries `machineVersion`. Without a declared `version` it falls back to a structural hash that skips functions, and in XState v6 the guards and targets live in transition functions. Changing a guard would not change the hash.
- Bump `version` on every behavior change. Adding recording is not one: it only observes. `improve-machine` bumps the policy's on promotion.

## 2. Pick a store

- **Tests and local runs:** `createInMemoryEventLogStore()` from `@statelyai/agent/log`, or write each thread's `result.events` to a JSON file after the run.
- **Production:** implement `AgentEventLogStore` against your database and check it with `assertEventLogStoreConformance`. Implement the optional `listThreads` so a split can be paged by prefix.

Pass it with a `threadId`. The store is write-ahead: no model call starts until the entries before it are durable.

```ts
const result = await runAgent(deskMachine, { input, executors, store, threadId, metadata });
await result.drain(); // late usage entries, before you read the store or exit
```

**A thread that already has entries is resumed, not overwritten.** Give every new run a new thread id; reuse one only to continue that run.

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

Read it back with `entries[0].metadata`. A resumed run keeps the stamp of the run that started the log. `executionId` is reserved. The value type is `JsonValue` from `@statelyai/agent/log`.

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

- In production, send them to OpenTelemetry instead: `createOtelTraceHandler({ tracer })` from `@statelyai/agent/otel` is an `onTrace` handler.
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
  const { snapshot } = replay(deskMachine, entries); // a pure fold: nothing runs
  expect(snapshot.value).toEqual(result.snapshot.value);
  expect(entries[0]!.metadata).toMatchObject({ environmentVersion: "1" });
});
```

- `foldTraces(traces, { failed })` over a batch returns a row for every decision state. `failed` judges one whole trace; start with "the last event is not a `run.end` with status `done`, or the run ended in a failure or sentinel state", and ask the user whether a wrong outcome counts too. `withheld` is above 0 only for a closed choice (`payloads`), where the guards refused an option.
- `getDecisionAttempts(entries)` lists the refused choices of a run. A stand-in model that picks from the offered options can never propose an illegal one, so write a raw decide executor for this test that proposes a refused event first: `decide: async (request) => ({ event: request.attempts.length ? request.options![0]!.event : { type: "REFUND", amount: 1000 } })`.
- Running a scenario with and without recording leaves the same world and the same final state.

## 7. Hand back

1. Where runs are stored and how thread ids are built.
2. The stamp fields.
3. Where trace events go.
4. The replay test passing.
5. Next step: `add-evals`.
