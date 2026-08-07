---
title: Debugging
description: Find out why an agent did the wrong thing, using the inspector, the trace stream, scripted reproduction, and the static linter.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

An agent machine fails in one of two places: the **machine** (a transition that was not legal, a guard that rejected, a state with no way out) or the **request** (the model picked badly, a tool threw, the output missed its schema). The debugging order below separates them.

## 1. Inspect the run visually

The [Stately Inspector](https://stately.ai/docs/inspector) renders your machine as a live state diagram: states highlight as they are entered, and every event and transition appears as it happens. Attach it to a run:

```ts
import { createInspector } from "@statelyai/sdk";
import { runAgent } from "@statelyai/agent";

const inspector = createInspector(); // hosted relay by default; pass `url` for self-hosted

await runAgent(machine, { input, executors, inspect: inspector.inspect });
```

`inspect` is a raw XState inspection passthrough, so child machines appear too. What to look for:

- The run stops in a state you did not expect: the transition you assumed exists is not there, or its guard returned `undefined`.
- A state is entered repeatedly: a decision is retrying (see below) or a loop guard never flips.
- The run never leaves a state with an `invoke`: the request is still pending or its `onError` is unhandled.

## 2. Read the trace stream

`onTrace` is the whole ordered ledger for a run: `request.start` / `request.end` / `request.error`, `stream.chunk`, `machine.transition`, `emit`, and run boundaries. It is the fastest way to see exactly what went to the model and what came back.

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

- `event.raw` on `request.end` is the executor's verbatim result: tool calls, tool results, usage.
- `onResult(request, { raw })` is the same data if you only care about model calls.
- Route on `request.name`, never on prompt text.

Three observation hooks are available, from broadest to narrowest:

- `onTrace`: every event in the run, in order.
- `onTransition`: machine transitions only, in XState terms.
- `on`: domain events the machine explicitly emits.

Details and OTel export: [Observability](observability.md).

## 3. Deterministic reproduction

Once you know roughly where it went wrong, take the model out. `createScriptedExecutors` replays canned answers with no API key, so the failure becomes a test.

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

Queue semantics are in [Scripted executors](hosts.md#scripted-executors). Two of them matter while debugging:

- A guard-rejected decision consumes an entry and retries with the next one, which is how you reproduce a retry loop exactly.
- Running dry throws with `error.code === 'scripted-executors-exhausted'`, naming the pending request. That is itself a signal: the machine asked for more model calls than you expected.

For a playthrough without the run loop at all, `simulateAgent(machine, { input, script })` walks the pure step path with responses keyed by invoke `src`, returning `{ status, snapshot, trail }`. The `trail` shows every step taken, which answers "why did it end up here" without any async in the way. See [Testing and verification](verify.md).

To reproduce a run that already happened in production, feed `result.events` to `replay(machine, events)`; `verifyReplay` additionally requires every hash to match, so a divergence is pinpointed to an entry. See [The event log](event-log.md).

## 4. Machine lint

Some wrong behavior is structural, and `lintAgentMachine(machine)` finds it with no run at all:

```ts
import { assertAgentMachine, lintAgentMachine } from "@statelyai/agent";

console.log(lintAgentMachine(machine)); // AgentLintDiagnostic[]: { code, severity, path, message }
assertAgentMachine(machine); // throws AgentLintError on any error-severity finding
```

Diagnostic codes worth recognizing:

| Code                     | What it means                                                   |
| ------------------------ | --------------------------------------------------------------- |
| `unreachable-state`      | No transition reaches the state; the model can never get there. |
| `decide-without-events`  | A decision whose candidate set is empty, so it can only fail.   |
| `undeclared-event`       | A transition on an event the setup never declared.              |
| `missing-final`          | No final state, so a run cannot settle `done`.                  |
| `final-without-output`   | A final state that does not satisfy the output contract.        |
| `unserializable-context` | Context that cannot be persisted or replayed.                   |

## Error codes

<!-- codes and classes from src/errors.ts, src/run-agent.ts, src/decision.ts, src/effects.ts, src/verify.ts, src/event-log-store.ts, src/scripted-executors.ts, src/seam.ts -->

Every framework error extends `AgentError` and carries a stable kebab-case `code`. Branch on the code, not `instanceof`, which is unreliable across bundle and process boundaries:

```ts no-check
if (error instanceof AgentError && error.code === "decision-exhausted") {
  // error.attempts
}
```

| Code                           | Thrown by                                                  | Meaning                                                                       | First fix                                                                           |
| ------------------------------ | ---------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `agent-idle`                   | `generateResult`                                           | The machine paused for external input instead of completing.                  | Use `runAgent` and handle `status: 'idle'`; `error.acceptedTypes` resumes it.       |
| `illegal-resume-event`         | `runAgent` (before start, with `snapshot` + `event`)       | The restored state does not accept that event type.                           | Pick from `getAcceptedEvents(snapshot)`, or pass `onIllegalResumeEvent: 'ignore'`.  |
| `snapshot-version-mismatch`    | `runAgent` (resume)                                        | The snapshot's stamped machine version differs from the current machine's.    | Supply `migrateSnapshot`, or set `onVersionMismatch` to `'warn'` / `'ignore'`.      |
| `max-model-calls-exceeded`     | `runAgent` internals                                       | The `maxModelCalls` budget (default 100) was exceeded.                        | Raise the budget, or fix the loop guard that never terminates.                      |
| `decision-exhausted`           | `resolveDecision`                                          | Every attempt (`maxRetries + 1`) failed validation or a guard.                | Read `error.attempts[].failure`; reconcile `allowedEvents`, schema, and guard.      |
| `lint-failed`                  | `assertAgentMachine`                                       | The machine has at least one error-severity lint finding.                     | Read `error.diagnostics`, or call `lintAgentMachine` for the full list.             |
| `replay-machine-mismatch`      | `replay` / `verifyReplay`                                  | A log entry is stamped for a different machine id or version.                 | Replay against the machine that wrote the log, or set an explicit `machineVersion`. |
| `replay-divergence`            | `replay` / `verifyReplay`                                  | Recomputed state, effects, or missing hashes disagree with the entry.         | `error.index` / `error.kind` name the entry; look for impurity at that step.        |
| `non-serializable-event`       | `createReplayEntry`, `initEntry`, `store.append`, `replay` | A value JSON would drop or coerce (`undefined`, `Date`, `Map`, class, cycle). | `error.path` names the field; store a plain-JSON equivalent instead.                |
| `event-log-conflict`           | `AgentEventLogStore.append`                                | A concurrent writer already advanced the thread past `expectedIndex`.         | Re-read with `store.length(threadId)` and retry the append.                         |
| `scripted-executors-exhausted` | `createScriptedExecutors`                                  | The canned script ran dry on a pending request.                               | Add entries, or ask why the machine wanted more model calls than you scripted.      |
| `seam-script-exhausted`        | `runSeam`                                                  | No scripted answer left for a seam request.                                   | Add an entry to `scripts.<key>`; its last entry repeats.                            |

`result.cause` on an `error` result is a separate, shorter union: `'aborted' | 'max-model-calls' | 'decision-exhausted' | 'machine' | 'stopped'`.

## Common failure modes

<!-- errors and codes from src/decision.ts, src/run-agent.ts, src/effects.ts, src/verify.ts, src/event-log-store.ts -->

**The model kept picking an illegal event.** `AgentDecisionExhaustedError` (`decision-exhausted`): every attempt (up to `maxRetries + 1`) failed one of three checks. Read `error.attempts`; each has a `failure`:

- `unknown-event`: the model named an event that is not a candidate. Usually `allowedEvents` disagrees with what the state accepts.
- `invalid-payload`: the event type was right, the payload missed its schema. Tighten the prompt or loosen the schema.
- `rejected-by-guard`: the machine said no. This is the system working; if it repeats, the guard and the prompt disagree about the rule.

An unhandled `decision-exhausted` settles the run as `{ status: 'error', cause: 'decision-exhausted' }`. Handle it on the decision invoke's `onError` to route somewhere sane.

**The run stopped early with no error state.** Check `result.cause` on an `error` result:

- `'aborted'`: your `signal` fired.
- `'max-model-calls'`: the `maxModelCalls` budget (default 100) was exceeded.
- `'stopped'`: the actor was stopped externally.
- `'machine'`: any other machine error state.

A budget exhaustion usually means a loop guard never terminates; look at `result.usage.modelCalls` and [Usage and budgets](usage-and-budgets.md).

**`generateResult` threw instead of returning.** `AgentIdleError` (`agent-idle`): the machine paused for external input. `error.acceptedTypes` lists the events that resume it. Use `runAgent` when idle is expected. See [Human in the loop](human-in-the-loop.md).

**Resuming a snapshot failed.**

- `AgentIllegalResumeEventError` (`illegal-resume-event`): the restored state does not accept the event; `error.acceptedTypes` says what it does accept. `onIllegalResumeEvent: 'ignore'` opts out.
- `AgentSnapshotVersionMismatchError` (`snapshot-version-mismatch`): the machine's structure changed since the snapshot was persisted. Supply `migrateSnapshot`, or set `onVersionMismatch` to `'warn'`/`'ignore'`.

**Replay did not match.** `AgentReplayMachineMismatchError` (`replay-machine-mismatch`) means the log targets a different machine or version. `AgentReplayDivergenceError` (`replay-divergence`) names the entry index and whether state, effects, or verification hashes diverged.

**The log would not persist.** `NonSerializableAgentEventError` (`non-serializable-event`) names the offending field path; `AgentEventLogConflictError` (`event-log-conflict`) means a concurrent writer won the append.

## Related

- [Observability](observability.md): the trace stream, the inspector, and OTel export.
- [Testing and verification](verify.md): `lintAgentMachine`, `simulateAgent`, `canReach`.
- [The event log](event-log.md): replay, `verifyReplay`, and forking a log.
- [Usage and budgets](usage-and-budgets.md): model-call and token accounting.
- [Decisions](decisions.md): retries, `allowedEvents`, and guard rejection.
