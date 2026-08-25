---
title: Evals
description: Score agent runs on output, trajectory, and token budget using the seams runAgent already returns, with plain vitest or a vendor harness like Braintrust.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

This page describes how to score agent runs on output, trajectory, and token budget. It covers a plain vitest runner, a vendor harness, per-call seam evals, and datasets built from event logs.

An eval is a dataset, a task, and scorers. The task is usually the hard part: getting a repeatable run out of an agent, and getting enough out of that run to score more than its final string. A machine provides both without eval-specific instrumentation, using what `runAgent` already returns.

## Machine evaluability

- Every run produces `result.events`, a versioned JSON log of every external input the run observed. Persist it and the run reproduces, so a failing eval row is a file.
- The trajectory is a durable artifact. The machine's states and the log's event types report which path the agent took, so no heuristic over free text is needed.
- `createScriptedExecutors` substitutes canned answers for the model, so trajectory and budget logic are unit-testable in CI with no API key.
- The machine decides what may happen next, not the prompt, so a scorer never has to check for actions that could not occur.

## The seams

A **seam** is a point in a run where an eval can substitute its own behavior or read the run's state. Each seam below is either a place to inject scripted answers or a place to read a trajectory, an output, or a usage count. One kind of seam, a single model call, is covered in [Seam evals with `runSeam`](#seam-evals-with-runseam).

| Seam                        | What it gives an eval                                                                                                                                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createScriptedExecutors`   | Canned model answers from FIFO queues, keyless and deterministic. Entries can report `usage`, so budget scorers have numbers without a model. See [Scripted executors](hosts.md#scripted-executors). |
| `runSeam`                   | Puts one model call under test and scripts the rest. Returns the seam's answer plus `before` and `after` trajectory slices, so a score is per call instead of per run.                                                      |
| `simulateAgent`             | A scripted playthrough on the pure step path. Returns a `trail` of state values per step, with no actor and no I/O.                                                                                              |
| `explorePaths` and `canReach` | Enumerate every branch a machine can take. `canReach` returns `{ reachable, witness }`. Use them to check which paths a dataset never exercises.                                                                                        |
| `result.events`             | The durable trajectory, as `AgentLogEntry[]`: machine input, effect completions, user events, and timer firings. Ordered, JSON-safe, and replayable.                                                                        |
| `onTransition`              | The live state path, one call per transition.                                                                                                                                                                    |
| `result.usage`              | `modelCalls` plus token fields, per run. Counts only that run's calls, so sum across resume legs.                                                                                                                |
| `result.output`             | The final state's typed output, schema-validated.                                                                                                                                                                |

See [Testing and verification](verify.md) for `simulateAgent`, `explorePaths`, and static linting in detail, and [The event log](event-log.md) for the log's envelope.

## A dataset runner in plain vitest

An eval needs no vendor. [Vitest](https://vitest.dev) is a plain JavaScript test runner. An eval in vitest is a dataset, a task that runs the machine, and scorers that are ordinary functions.

```ts no-check
import { expect, test } from "vitest";
import { createScriptedExecutors, runAgent } from "@statelyai/agent";
import { triageMachine } from "./triage-machine.js";

const dataset = [
  {
    name: "duplicate charge is billing + negative",
    input: { ticket: "I was charged twice for March. Please refund." },
    script: { sentiment: "negative", category: "billing", reply: "We will refund it." },
    expected: { category: "billing", states: ["triaging", "done"] },
  },
];

test.each(dataset)("$name", async ({ input, script, expected }) => {
  const statePath: string[] = [];

  const result = await runAgent(triageMachine, {
    input,
    executors: createScriptedExecutors({ text: [script] }),
    onTransition: (snapshot) => statePath.push(String(snapshot.value)),
  });

  expect(result.status).toBe("done");
  // Output scorer.
  expect(result.output.category).toBe(expected.category);
  // Trajectory scorer.
  expect(statePath).toEqual(expected.states);
  // Budget scorer.
  expect(result.usage.modelCalls).toBeLessThanOrEqual(1);
});
```

Replace `createScriptedExecutors` with `createAiSdkExecutors({ models })` and the same rows score a real model. That is the only line that changes.

### Trajectory scoring

Two trajectories are available, and they answer different questions.

- The state path, from `onTransition`, records where the machine went. It is readable and is the usual thing to assert.
- The event trajectory, from `result.events`, records what drove the machine there. It is durable and JSON-safe, so it survives the process, and it is the same artifact that powers replay and crash recovery.

Score a trajectory as an ordered subsequence rather than an exact match, so an extra retry loop does not fail a row that reached the right states in the right order. `matchesTrajectory` performs that comparison over either trajectory.

```ts
import { matchesTrajectory } from "@statelyai/agent";

// State path: strings, dot paths, or the nested value XState reports.
const statePath: string[] = [];
const path = matchesTrajectory(statePath, ["prompting", "drafting", "sent"]);
expect(path.matched, JSON.stringify(path.firstMiss)).toBe(true);

// Event log: `AgentLogEntry[]` compares by event type, payload keys opt-in.
matchesTrajectory(result.events, ["PROMPT_SUBMITTED", { type: "MORE_INFO" }, "SEND"]);
```

- The comparison is an ordered subsequence by default. Pass `{ exact: true }` to require equality.
- `score` is `matchedCount / expectedCount`, so a scorer gets partial credit.
- `firstMiss` is `{ index, expected, searchedFrom }`, which reports where the trajectory diverged. It is JSON-safe, so it works as scorer metadata and as a test failure message.

### Human-in-the-loop rows

A machine that pauses for a human settles `idle`. Resume with `{ snapshot, event }` and pass `events` through each leg, so the final `result.events` holds the whole run's log. Two details matter.

```ts no-check
const first = await runAgent(machine, { input, executors });
const second = await runAgent(machine, {
  snapshot: first.persistedSnapshot ?? first.snapshot,
  event: { type: "APPROVE" },
  events: first.events, // thread the log forward
  executors,
});
// second.events is the whole run's log
const modelCalls = first.usage.modelCalls + second.usage.modelCalls;
```

- `usage` is per leg. Sum it across legs.
- Drive the simulated user from the machine's current state or its `meta.interaction`, not from a fixed transcript. A real model may branch differently, and a reactive user policy scores that run instead of failing on it.

## Braintrust

[Braintrust](https://www.braintrust.dev) is a hosted eval platform. You give it a dataset, a task function, and scorers, and it tracks scores across experiments.

[`examples/braintrust-evals`](https://github.com/statelyai/agent/tree/main/examples/braintrust-evals) wires the real `braintrust` SDK over the unmodified email-drafter machine. It has a three-row dataset, a task that drives the machine to done, and four scorers over `result.output`, the state path, the `result.events` trajectory, and summed `result.usage`.

```ts
import { Eval } from "braintrust";

await Eval(
  "statelyai-agent email-drafter",
  {
    data: dataset,
    task: (input: unknown) => runDrafterCase(input),
    scores: [scoreOutputStructure, scoreStatePath, scoreEventTrajectory, scoreTokenBudget],
  },
  { noSendLogs: !process.env.BRAINTRUST_API_KEY },
);
```

- `noSendLogs: true` runs the eval locally and prints a summary instead of creating an experiment, so it needs no Braintrust account.
- Set `BRAINTRUST_API_KEY` to upload the experiment instead. That path requires an account.
- Set `OPENAI_API_KEY` to score the real model. Without it, the eval runs scripted and keyless.

The same structure works with any harness that takes a task function and scorers.

## Seam evals with `runSeam`

An end-to-end score reports that a run got worse. It does not report which model call got worse. A machine agent is a chain of calls, and each call is a seam you can eval on its own without mocking the machine.

To eval a seam, run the machine end to end but route every request except one to a scripted answer. The seam under test receives the real model or a candidate prompt. Everything after the seam is a consequence of it, so the slice of the run after the seam is what you score.

`runSeam` does this in one call. It routes the requests, drives a reactive simulated user through the idle pauses, and slices the run at the seam.

<!-- viz: seam eval: chain of model calls in one run, all scripted except the seam under test, with before/after trajectory slices marked at the seam's completion -->

<!-- runSeam options and result fields from src/seam.ts -->

```ts
import { matchesTrajectory, runSeam } from "@statelyai/agent";

const run = await runSeam(emailDrafter, {
  // The call plan: answers per request `name` or model key, in call order.
  scripts: {
    evaluatePrompt: [vagueAssessment, completeAssessment],
    draftEmail: [draft],
  },
  // The call under test: request name plus zero-based occurrence.
  seam: { request: "evaluatePrompt", occurrence: 0 },
  // The seam's executor. Omit it to script the seam as well.
  candidate: createAiSdkExecutors({ models }).generateText,
  // The simulated user, answering off the machine's own state.
  respond: ({ state }) =>
    state === "prompting"
      ? { type: "PROMPT_SUBMITTED" as const, prompt }
      : { type: "SEND" as const },
});
```

- `seam` addresses the call by request `name` plus a zero-based `occurrence`. The name is the `setupAgent({ requests })` key, or the `name` passed to `createTextLogic`. For example, `{ request: "draftEmail", occurrence: 1 }` is the revision, not the first draft. A request the seam addresses must have a name.
- `scripts` is the whole call plan, and the seam consumes its slot too. The candidate replaces that answer, and every later scripted answer stays lined up. A queue keys on a request `name` when one is scripted under it, and on a `model` key otherwise.
- A queue that runs dry throws. Pass `repeatLast: true` to replay a queue's last entry instead, so a live seam that branches down a longer path still finds an answer.
- `respond` is called at every idle pause with `{ snapshot, state, meta, turn, result }`. It returns the event to send, or `null` to stop.
- `candidate` is an executor, so a candidate prompt, a fine-tuned model, or a live model all plug in.

The result carries the seam's own answer and two slices, ready for `matchesTrajectory`.

```ts
run.seamOutput; // what the seam call returned
run.callsBeforeSeam; // model calls made before it (-1 if never reached)
run.before; // { statePath, events } up to the seam's completion
run.after; // { statePath, events } from it onward: the branch the seam caused
run.result; // the full RunAgentResult; `events` is the whole run's log

matchesTrajectory(run.after.statePath, ["needsMoreInfo", "drafting", "reviewing"]);
matchesTrajectory(run.after.events, ["MORE_INFO", "SEND", "END"]);
```

The state slice splits at the point the state path had reached when the seam answered. The event slice splits at the seam's own effect completion, which is the first `xstate.done.*` entry appended after the call was made. A run that never reaches the seam returns an empty `after` slice instead of throwing, which is itself a result about the candidate.

### One experiment per seam

The email drafter has three seams. Give each seam its own `Eval()` call, so a vendor tracks per-seam scores over time instead of one blended number.

| Seam      | Call                      | The question the trajectory answers                      |
| --------- | ------------------------- | -------------------------------------------------------- |
| `clarify` | `evaluatePrompt`          | Did a vague prompt reach `needsMoreInfo`?                |
| `draft`   | `draftEmail`, first call  | Did the draft reach `reviewing` and get sent?            |
| `revise`  | `draftEmail`, second call | Did the revision survive review after `REQUEST_CHANGES`? |

```ts no-check
for (const seam of seams) {
  await Eval(`email-drafter seam: ${seam.id}`, {
    data: seam.rows,
    task: (input) => runSeamCase(input, candidate),
    scores: seam.scorers,
  });
}
```

A row is a Braintrust test case, which Langfuse calls a dataset item. Its shape is `{ input, expected, metadata }`. `input` carries the prompt, the simulated user's answers, and the call plan. `expected` carries the post-seam trajectory.

With no `candidate`, every seam runs scripted and keyless, and the same rows score the real model when a key is present. [`examples/braintrust-evals/seams.ts`](https://github.com/statelyai/agent/tree/main/examples/braintrust-evals) is a working version of all of this, with datasets, scorers, and `Eval()` wiring. For `runSeam` on its own, without a vendor, [`examples/seam-scoring`](../examples/seam-scoring/index.ts) scores one `draftEmail` call of the unmodified email drafter and prints a good and a bad candidate side by side.

## Datasets from event logs

Seam datasets do not have to be hand-written. A recorded run already contains every seam input. `result.events` is the log, and replaying a prefix of it reconstructs the exact request the next model call would receive.

```ts
import { replay } from "@statelyai/agent";
import type { AgentLogEntry, AgentTextRequest } from "@statelyai/agent";

/** One seam per model call in a recorded run: the prefix that produced it, and the request it owed. */
export function seamCasesFrom(machine: typeof emailDrafter, events: AgentLogEntry[]) {
  const cases: { prefix: AgentLogEntry[]; request: AgentTextRequest; recorded: unknown }[] = [];

  for (let at = 1; at <= events.length; at++) {
    const prefix = events.slice(0, at);
    // Strict replay: every entry's recorded state/effect hashes must check out,
    // so a fixture cannot drift away from the machine that produced it.
    const { effects } = replay(machine, prefix, { verify: "strict" });
    const owed = effects.find((effect) => effect.kind === "text");
    if (!owed) continue;

    // The completion the run actually recorded for that call, if it got one.
    // Match it by the request's own done event rather than by position: other
    // entries can be journaled between the call and its completion.
    const done = owed.toDoneEvent(undefined) as { type: string; actorId?: string };
    const completion = events.slice(at).find((entry) => {
      const event = entry.event as { type: string; actorId?: string };
      return event.type === done.type && event.actorId === done.actorId;
    });
    const output = (completion?.event as { output?: unknown } | undefined)?.output;
    cases.push({ prefix, request: owed.request, recorded: output });
  }

  return cases;
}
```

- A production run becomes one dataset row per model call, so recording a run once produces a regression case for every seam.
- `verify: 'strict'` makes the fixture trustworthy, because an entry whose recorded state or owed-effect hashes no longer match the machine throws `AgentReplayDivergenceError` instead of scoring a stale path.
- `owed.request` is the full `AgentTextRequest`, with system, prompt, messages, and schema. Pass it to a candidate model for a single-call eval, or use `prefix` as the starting log for a routed-executor run that scores the trajectory after the seam.
- `recorded` is the previous model's answer for that seam, so the dataset ships with a baseline to score against.

## Pairing with observability

Evals score runs offline, and tracing observes runs in production. Both read the machine's trace stream. A vendor with an OTLP endpoint, such as Braintrust, LangSmith, Langfuse, or Honeycomb, receives spans from `@statelyai/agent/otel` while the same runs are scored here. Neither side depends on the other, and neither requires a vendor-specific adapter in your machine.

## Related

- [Testing and verification](verify.md): `simulateAgent`, `explorePaths`, and static linting.
- [Observability](observability.md): the trace stream and OTel export.
- [The event log](event-log.md): the log envelope, replay, and strict verification.
- [Hosts and executors](hosts.md#scripted-executors): scripted executor semantics.
- [Usage and budgets](usage-and-budgets.md): what `result.usage` counts.
