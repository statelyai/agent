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
- **No secrets or personal data in metadata or thread ids.** Use ids, not names or emails.

## 1. Version the machines

Declare `version` on every machine whose runs you record: the environment and, if there is one, the policy.

```ts
export const deskMachine = deskSetup.createMachine({ id: "refund-desk", version: "3", ... });
```

- Every log entry carries `machineVersion`. Without a declared `version` it falls back to a structural hash that skips functions, and in XState v6 the guards and targets live in transition functions. Changing a guard would not change the hash.
- Bump `version` on every behavior change. `improve-machine` bumps the policy's on promotion.

## 2. Pick a store

- **Tests and local runs:** `createInMemoryEventLogStore()` from `@statelyai/agent/log`, or write each thread's `result.events` to a JSON file after the run.
- **Production:** implement `AgentEventLogStore` against your database and check it with `assertEventLogStoreConformance`. Implement the optional `listThreads` so a split can be paged by prefix.

Pass it with a `threadId`. The store is write-ahead: no model call starts until the entries before it are durable.

```ts
const result = await runAgent(deskMachine, { input, executors, store, threadId, metadata });
```

## 3. Name threads

A thread id is how runs are found later. Use a prefix scheme and keep it in one function:

| Runs                     | Thread id                                    |
| ------------------------ | -------------------------------------------- |
| Scenario runs for evals  | `<split>:<policyVersion>:<scenarioId>:r<k>`  |
| Production               | `prod:<domain id>` (ticket id, session id)   |

`store.listThreads({ prefix: "train:v3:" })` then pages through one split of one policy version.

## 4. Stamp each run

`metadata` lands on the log's first (`@agent.init`) entry. Put there everything needed to tell two runs' producers apart:

```ts
const metadata = {
  environmentVersion: deskMachine.version ?? "unversioned",
  policyVersion: policyMachine.version ?? "none",
  models: { decide: "openai/gpt-6-luna" },
  scenario: scenario.id, // eval runs only
  split: scenario.split, // eval runs only
};
```

Read it back with `entries[0].metadata`. A resumed run keeps the stamp of the run that started the log. `executionId` is reserved.

## 5. Collect trace events

`onTrace` sees every trace event. Serialize and keep them per thread:

```ts
import { serializeTraceEvent } from "@statelyai/agent";

const trace: unknown[] = [];
await runAgent(deskMachine, { ..., onTrace: (event) => trace.push(serializeTraceEvent(event)) });
await writeFile(`traces/${threadId}.json`, JSON.stringify(trace));
```

- In production, send them to OpenTelemetry instead: `createOtelTraceHandler({ tracer })` from `@statelyai/agent/otel` is an `onTrace` handler.
- **A policy run inside a decider** is a separate run. Pass it the same `onTrace` (and its own `store` thread, `<threadId>:policy:<n>`) if you want per-state stats for the policy too.
- **A plain XState machine** (built with `createMachine` or `setup`, decided with `decideNext`): drive it with `createAgentRuntime` and `runToQuiescence`, which accept plain machines, and pass each `decideNext` result as `{ event, attempts }` so refused choices reach the log. Push `{ type: "request.start", request: result.request }` onto the trace before sending the event, since a host-driven decision emits no trace itself.
- **A plain `createActor` run you cannot change:** attach `recordLog(actor)` from `@statelyai/agent/log` before `actor.start()`, and pass `inspect: traceTransitions((event) => trace.push(serializeTraceEvent(event)))` to `createActor`. `recordLog` cannot record decision attempts.

## 6. Prove it

Write these tests, with the stand-in model from `loop-to-machine`:

```ts
import { getDecisionAttempts, replay } from "@statelyai/agent/log";

test("a recorded run replays to its final state with no model calls", async () => {
  const result = await runAgent(deskMachine, { input, executors, store, threadId: "test:v3:small-clean:r1", metadata });
  const entries = await store.read("test:v3:small-clean:r1");
  const { snapshot } = replay(deskMachine, entries); // a pure fold: nothing runs
  expect(snapshot.value).toEqual(result.snapshot.value);
  expect(entries[0]!.metadata).toMatchObject({ environmentVersion: "3" });
});
```

- `foldTraces` over a batch returns a row for every decision state, with `withheld` above 0 where guards refused options.
- `getDecisionAttempts(entries)` lists the refused choices of a run where the stand-in model proposes an illegal one.

## 7. Hand back

1. Where runs are stored and how thread ids are built.
2. The stamp fields.
3. Where trace events go.
4. The replay test passing.
5. Next step: `add-evals`.
