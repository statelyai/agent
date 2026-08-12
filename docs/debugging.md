---
title: Debugging
description: Find out why an agent did the wrong thing, using the inspector, the trace stream, scripted reproduction, and the static linter.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

This page covers the tools for finding out why an agent run did the wrong thing, in the order to reach for them.

An agent machine fails in one of two places. It fails in the **machine** when a transition is not legal, a guard rejects an event, or a state has no way out. It fails in the **request** when the model chooses badly, a tool throws, or the output does not match its schema. The steps below separate the two.

## 1. Inspect the run visually

The [Stately Inspector](https://stately.ai/docs/inspector) renders your machine as a live state diagram. States highlight as they are entered, and every event and transition appears as it happens. Attach it to a run.

```ts
import { createInspector } from "@statelyai/sdk";
import { runAgent } from "@statelyai/agent";

const inspector = createInspector(); // hosted relay by default; pass `url` for self-hosted

await runAgent(machine, { input, executors, inspect: inspector.inspect });
```

`inspect` is a raw XState inspection passthrough, so child machines appear too. Look for these symptoms.

- The run stops in a state you did not expect. The transition you assumed exists is missing, or its guard returned `undefined`.
- A state is entered repeatedly. A decision is retrying, or a loop guard never flips.
- The run never leaves a state with an `invoke`. The request is still pending, or its `onError` is unhandled.

<!-- viz: debugging order as a flow: inspector -> trace stream -> scripted reproduction -> lint, with machine-side vs request-side failures branching -->

## 2. Read the trace stream

`onTrace` receives the whole ordered ledger for a run: `request.start`, `request.end`, `request.error`, `stream.chunk`, `machine.transition`, `emit`, and run boundaries. It shows exactly what went to the model and what came back.

```ts
await runAgent(machine, {
  input,
  executors,
  onTrace: (event) => {
    if (event.type === "request.start") console.log(event.request.id, event.request.kind);
    if (event.type === "request.end") console.log(event.request.id, event.output, event.raw);
    if (event.type === "machine.transition") console.log(event.event.type, event.snapshot.value);
  },
});
```

- `event.raw` on `request.end` is the executor's verbatim result, including tool calls, tool results, and usage.
- `onResult(request, { raw })` gives the same data if you only care about model calls.
- Route on `request.name`, not on prompt text.

Three observation hooks are available, from broadest to narrowest.

- `onTrace`: every event in the run, in order.
- `onTransition`: machine transitions only, in XState terms.
- `on`: domain events the machine explicitly emits.

Read more about the trace stream and OTel export in [Observability](observability.md).

## 3. Deterministic reproduction

Once you know roughly where the run went wrong, remove the model. `createScriptedExecutors` replays canned answers with no API key, which turns the failure into a test.

```ts
import { createScriptedExecutors, runAgent } from "@statelyai/agent";

const result = await runAgent(machine, {
  input: { comment: "…", trust: 20 },
  executors: createScriptedExecutors({
    decisions: [{ type: "PUBLISH" }, { type: "FLAG", reason: "Borderline." }],
    text: ["a canned answer"],
  }),
});
```

Read more about queue semantics in [Scripted executors](hosts.md#scripted-executors). Two behaviors matter while debugging.

- A guard-rejected decision consumes an entry and retries with the next one. This reproduces a retry loop exactly.
- Running dry throws with `error.code === 'scripted-executors-exhausted'` and names the pending request. This also tells you the machine asked for more model calls than you expected.

To replay without the run loop, call `simulateAgent(machine, { input, script })`. It walks the pure step path with responses keyed by invoke `src` and returns `{ status, snapshot, trail }`. The `trail` lists every step taken, with no async involved. See [Testing and verification](verify.md).

To reproduce a run that already happened in production, pass `result.events` to `replay(machine, events)`. Add `{ verify: 'strict' }` to require every recorded hash to be present and match, which pinpoints a divergence to a single entry. See [The event log](event-log.md).

## 4. Machine lint

Some wrong behavior is structural. `lintAgentMachine(machine)` finds it without running the machine.

```ts
import { lintAgentMachine } from "@statelyai/agent";

console.log(lintAgentMachine(machine)); // AgentLintDiagnostic[]: { code, severity, path, message }
lintAgentMachine(machine, { throw: true }); // throws AgentLintError on any error-severity finding
```

Common diagnostic codes:

| Code                     | What it means                                                   |
| ------------------------ | --------------------------------------------------------------- |
| `unreachable-state`      | No transition reaches the state, so the model can never get there. |
| `decide-without-events`  | A decision whose candidate set is empty, so it can only fail.   |
| `undeclared-event`       | A transition on an event the setup never declared.              |
| `missing-final`          | No final state, so a run cannot settle `done`.                  |
| `final-without-output`   | A final state that does not satisfy the output contract.        |
| `unserializable-context` | Context that cannot be persisted or replayed.                   |

## Error codes

<!-- codes and classes from src/errors.ts, src/run-agent.ts, src/decision.ts, src/effects.ts, src/verify.ts, src/event-log-store.ts, src/scripted-executors.ts, src/seam.ts -->

Every framework error extends `AgentError` and carries a stable kebab-case `code`. Branch on the code rather than `instanceof`. `instanceof` is unreliable across bundle and process boundaries.

```ts no-check
if (error instanceof AgentError && error.code === "decision-exhausted") {
  // error.attempts
}
```

| Code                           | Thrown by                                                  | Meaning                                                                       | First fix                                                                           |
| ------------------------------ | ---------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `agent-idle`                   | `generateResult`                                           | The machine paused for external input instead of completing.                  | Use `runAgent` and handle `status: 'idle'`; `error.acceptedTypes` resumes it.       |
| `illegal-resume-event`         | `runAgent` (before start, with `snapshot` + `event`)       | The restored state does not accept that event type.                           | Pick the resume event from `getAcceptedEvents(snapshot)`.                           |
| `snapshot-version-mismatch`    | `runAgent` (resume)                                        | The snapshot's stamped machine version differs from the current machine's.    | Supply `migrateSnapshot`, or set `onVersionMismatch` to `'warn'` / `'ignore'`.      |
| `max-model-calls`              | `runAgent` internals                                       | The `maxModelCalls` budget (default 100) was exceeded.                        | Raise the budget, or fix the loop guard that never terminates.                      |
| `missing-decide-executor`      | `resolveDecision`                                          | The executor set passed in has no `decide` function.                          | Pass the whole executor set, built with `createAiSdkExecutors({ models })`.         |
| `decision-exhausted`           | `resolveDecision`                                          | Every attempt (`maxRetries + 1`) failed validation or a guard.                | Read `error.attempts[].failure`; reconcile `allowedEvents`, schema, and guard.      |
| `lint-failed`                  | `lintAgentMachine(machine, { throw: true })`               | The machine has at least one error-severity lint finding.                     | Read `error.diagnostics`, or call `lintAgentMachine` for the full list.             |
| `replay-machine-mismatch`      | `replay`                                                   | A log entry is stamped for a different machine id or version.                 | Replay against the machine that wrote the log, or set an explicit `machineVersion`. |
| `replay-divergence`            | `replay`                                                   | Recomputed state, effects, or missing hashes disagree with the entry.         | `error.index` / `error.kind` name the entry; look for impurity at that step.        |
| `non-serializable-event`       | `createReplayEntry`, `initEntry`, `store.append`, `replay` | A value JSON would drop or coerce (`undefined`, `Date`, `Map`, class, cycle). | `error.path` names the field; store a plain-JSON equivalent instead.                |
| `event-log-conflict`           | `AgentEventLogStore.append`                                | A concurrent writer already advanced the thread past `expectedIndex`.         | Read `error.actualIndex`, or call `store.length(threadId)`, and retry the append.   |
| `scripted-executors-exhausted` | `createScriptedExecutors`                                  | The canned script ran dry on a pending request.                               | Add entries, or ask why the machine wanted more model calls than you scripted.      |
| `seam-script-exhausted`        | `runSeam`                                                  | No scripted answer left for a seam request.                                   | Add an entry to `scripts.<key>`, or pass `repeatLast: true`.                        |

Each code has a class, and every class extends `AgentError`.

| Class                              | Code                       |
| ---------------------------------- | -------------------------- |
| `AgentIdleError`                   | `agent-idle`               |
| `AgentIllegalResumeEventError`     | `illegal-resume-event`     |
| `AgentSnapshotVersionMismatchError`| `snapshot-version-mismatch`|
| `AgentDecisionExhaustedError`      | `decision-exhausted`       |
| `AgentLintError`                   | `lint-failed`              |
| `AgentReplayMachineMismatchError`  | `replay-machine-mismatch`  |
| `AgentReplayDivergenceError`       | `replay-divergence`        |
| `NonSerializableAgentEventError`   | `non-serializable-event`   |
| `AgentEventLogConflictError`       | `event-log-conflict`       |
| `AgentMaxModelCallsExceededError`  | `max-model-calls`          |

`result.cause` is separate from these codes. It appears on an `error` result and is a shorter union: `'aborted' | 'max-model-calls' | 'decision-exhausted' | 'machine' | 'stopped'`. A thrown `AgentError` carries a `code`, while a settled `error` result carries a `cause`.

## Common failure modes

<!-- errors and codes from src/decision.ts, src/run-agent.ts, src/effects.ts, src/verify.ts, src/event-log-store.ts -->

Two failures need more than the table above.

### The model kept picking an illegal event

`decision-exhausted` means every attempt, up to `maxRetries + 1`, failed one of three checks. Read `error.attempts`. Each attempt has a `failure`:

- `unknown-event`: the model named an event that is not a candidate. Usually `allowedEvents` disagrees with what the state accepts.
- `invalid-payload`: the event type was correct but the payload did not match its schema. Tighten the prompt or loosen the schema.
- `rejected-by-guard`: the machine rejected the event. If this repeats, the guard and the prompt disagree about the rule.

An unhandled `decision-exhausted` settles the run as `{ status: 'error', cause: 'decision-exhausted' }`. Handle it on the decision invoke's `onError` to route elsewhere.

### The run stopped early with no error state

Check `result.cause` on an `error` result:

- `'aborted'`: your `signal` fired.
- `'max-model-calls'`: the `maxModelCalls` budget, default 100, was exceeded.
- `'stopped'`: the actor was stopped externally.
- `'machine'`: any other machine error state.

Budget exhaustion usually means a loop guard never terminates. Check `result.usage.modelCalls` and see [Usage and budgets](usage-and-budgets.md).

## Related

- [Observability](observability.md): the trace stream, the inspector, and OTel export.
- [Testing and verification](verify.md): `lintAgentMachine`, `simulateAgent`, `canReach`.
- [The event log](event-log.md): replay, strict verification, and forking a log.
- [Usage and budgets](usage-and-budgets.md): model-call and token accounting.
- [Decisions](decisions.md): retries, `allowedEvents`, and guard rejection.
