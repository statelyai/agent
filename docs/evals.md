---
title: Evals
description: Score agent runs on output, trajectory, and token budget using the seams runAgent already returns, with plain vitest or a vendor harness like Braintrust.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

An eval is a dataset, a task, and scorers. The hard part is usually the task: getting a repeatable run out of an agent, and getting enough out of that run to score more than its final string.

A machine gives you both for free. Nothing here is eval-specific instrumentation; it is what `runAgent` already returns.

## Machine evaluability

- **Deterministic replay.** Every run produces `result.events`, a versioned JSON log of every external input it observed. Persist it and the run reproduces. A failing eval row is a file, not a screenshot.
- **The trajectory is a first-class artifact.** The question "did the agent take the right path?" is not a heuristic over free text. The machine's states and the log's event types answer it directly.
- **Keyless runs.** `createScriptedExecutors` swaps canned answers in for the model. Same machine, same executor contract, no API key and no network, so trajectory and budget logic are unit-testable in CI.
- **Illegal paths are impossible.** The machine, not the prompt, decides what may happen next, so a scorer never has to check for actions that could not occur.

## The seams

| Seam                        | What it gives an eval                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `createScriptedExecutors`   | Canned model answers from FIFO queues. Keyless, deterministic, free. Entries can report `usage`, so budget scorers have numbers without a model. |
| `runSeam`                   | One model call under test, the rest scripted. Returns the seam's answer plus `before`/`after` trajectory slices, so a score is per-call instead of per-run. |
| `simulateAgent`             | A scripted playthrough on the pure step path. Returns a `trail` of state values per step, with no actor and no I/O.                              |
| `explorePaths` / `canReach` | Enumerate every branch a machine can take. Use it to check dataset coverage: which paths does the dataset never exercise?                        |
| `result.events`             | The durable trajectory. `AgentLogEntry[]`: machine input, effect completions, user events, timer firings. JSON-safe, ordered, replayable.        |
| `onTransition`              | The live state path, one call per transition.                                                                                                    |
| `result.usage`              | `modelCalls` plus token fields, per run. Counts only that run's calls, so sum across resume legs.                                                |
| `result.output`             | The final state's typed output, schema-validated.                                                                                                |

See [Testing and verification](verify.md) for `simulateAgent`, `explorePaths`, and static linting in detail, and [The event log](event-log.md) for the log's envelope.

## A dataset runner in plain vitest

No vendor required. [Vitest](https://vitest.dev) is a plain JavaScript test runner; an eval here is just a dataset, a task that runs the machine, and scorers that are ordinary functions:

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

Swap `createScriptedExecutors` for `createAiSdkExecutors({ models })` and the same rows score a real model. That is the only line that changes.

### Trajectory scoring

Two trajectories are available, and they answer different questions:

- **State path** (`onTransition`): where the machine went. Readable, and the natural thing to assert.
- **Event trajectory** (`result.events`): what drove it there. Durable and JSON-safe, so it survives the process, and it is the same artifact that powers replay and crash recovery.

Score them as an ordered subsequence rather than an exact match, so an extra retry loop does not fail a row that reached the right places in the right order. `matchesTrajectory` is that comparison, over either trajectory:

```ts
import { matchesTrajectory } from "@statelyai/agent";

// State path: strings, dot paths, or the nested value XState reports.
const statePath: string[] = [];
const path = matchesTrajectory(statePath, ["prompting", "drafting", "sent"]);
expect(path.matched, JSON.stringify(path.firstMiss)).toBe(true);

// Event log: `AgentLogEntry[]` compares by event type, payload keys opt-in.
matchesTrajectory(result.events, ["PROMPT_SUBMITTED", { type: "MORE_INFO" }, "SEND"]);
```

- Ordered subsequence by default; `{ exact: true }` requires equality.
- `score` is `matchedCount / expectedCount`, so a scorer gets partial credit for free.
- `firstMiss` is `{ index, expected, searchedFrom }` — where it diverged, JSON-safe, so it doubles as scorer metadata and as a test failure message.

### Human-in-the-loop rows

A machine that pauses for a human settles `idle`. Resume with `{ snapshot, event }` and thread `events` through each leg so the final `result.events` is the whole run's log. Two things to remember:

- `usage` is per leg. Sum it.
- Drive the simulated user off the machine's current state or its `meta.interaction`, not a fixed transcript. A real model may branch differently, and a reactive user policy scores that run instead of crashing on it.

## Braintrust

[Braintrust](https://www.braintrust.dev) is a hosted eval platform: you hand it a dataset, a task function, and scorers, and it tracks scores across experiments.

[`examples/braintrust-evals`](https://github.com/statelyai/agent/tree/main/examples/braintrust-evals) wires the real `braintrust` SDK over the unmodified email-drafter machine: a three-row dataset, a task that drives the machine to done, and four scorers over `result.output`, the state path, the `result.events` trajectory, and summed `result.usage`.

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

- `noSendLogs: true` runs the eval locally and prints a summary instead of creating an experiment, so it works with **no Braintrust account**.
- Set `BRAINTRUST_API_KEY` to upload the experiment instead. That path needs an account.
- Set `OPENAI_API_KEY` to score the real model. Unset, it runs scripted and keyless.

The same shape ports to any harness that takes a task function and scorers.

## Seam evals with `runSeam`

An end-to-end score tells you a run got worse. It does not tell you **which model call** got worse. A machine agent is a chain of calls, and each one is a seam you can eval on its own without mocking the machine.

The recipe: run the machine end to end, but route every request except one to a scripted answer. The seam under test gets the real model (or a candidate prompt). Everything after the seam is a real consequence of it, so the slice of the run after the seam is the score.

`runSeam` is that recipe as one call. It routes the requests, drives a reactive simulated user through the idle pauses, and slices the run at the seam:

```ts
import { matchesTrajectory, runSeam } from "@statelyai/agent";

const run = await runSeam(emailDrafter, {
  // The call plan: answers per request `name` or model key, in call order.
  scripts: {
    promptEvaluator: [vagueAssessment, completeAssessment],
    emailDrafter: [draft],
  },
  // The call under test — by request name, or by model key plus occurrence.
  seam: { model: "promptEvaluator", occurrence: 0 },
  // The seam's executor. Omit it and the seam is scripted too: keyless.
  candidate: createAiSdkExecutors({ models }).generateText,
  // The simulated user, answering off the machine's own state.
  respond: ({ state }) =>
    state === "prompting"
      ? { type: "PROMPT_SUBMITTED" as const, prompt }
      : { type: "SEND" as const },
});
```

- `seam` addresses the call by request `name` (the `setupAgent({ requests })` key, the better handle) or by `model` key, plus a 0-based `occurrence` — `{ request: "draftEmail", occurrence: 1 }` is the revision, not the first draft.
- `scripts` is the whole call plan, so the seam consumes its slot too: the candidate *replaces* that answer, and every later scripted answer stays lined up. Each queue's **last entry repeats**, so a live seam that branches down a longer path never runs dry.
- `respond` is called at every idle pause with `{ snapshot, state, meta, turn, result }` and returns the event to send, or `null` to stop. Drive it off the state or the state's `meta.interaction` — a real model may branch differently, and a reactive policy scores that run instead of crashing on it.
- `candidate` is just an executor, so a candidate prompt, a fine-tune, or a live model all plug in. Without it the whole run is keyless and deterministic.

The result carries the seam's own answer and two slices, ready for `matchesTrajectory`:

```ts
run.seamOutput; // what the seam call returned
run.callsBeforeSeam; // model calls made before it (-1 if never reached)
run.before; // { statePath, events } up to the seam's completion
run.after; // { statePath, events } from it onward — the branch the seam caused
run.result; // the full RunAgentResult; `events` is the whole run's log

matchesTrajectory(run.after.statePath, ["needsMoreInfo", "drafting", "reviewing"]);
matchesTrajectory(run.after.events, ["MORE_INFO", "SEND", "END"]);
```

The state slice splits where the state path stood when the seam answered; the event slice splits at the seam's own effect completion (the first `xstate.done.*` entry appended after the call was made). A run that never reaches the seam scores an empty `after` rather than throwing — that is a real result about the candidate.

### One experiment per seam

The email drafter has three seams. Give each its own `Eval()` so a vendor tracks per-seam scores over time instead of one blended number:

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

A row is a Braintrust **test case** (Langfuse calls it a **dataset item**): `{ input, expected, metadata }`, where `input` carries the prompt, the simulated user's answers, and the call plan, and `expected` carries the post-seam trajectory.

Keyless-first still holds: with no `candidate`, every seam runs scripted, and the same rows score the real model when a key is present. [`examples/braintrust-evals/seams.ts`](https://github.com/statelyai/agent/tree/main/examples/braintrust-evals) is the working version of all of this — datasets, scorers and `Eval()` wiring, with `runSeam` doing the rest.

## Datasets from event logs

Seam datasets do not have to be hand-written. A recorded run already contains every seam input: `result.events` is the log, and replaying a **prefix** of it reconstructs the exact request the next model call would receive.

```ts
import { verifyReplay } from "@statelyai/agent";
import type { AgentLogEntry, AgentTextRequest } from "@statelyai/agent";

/** One seam per model call in a recorded run: the prefix that produced it, and the request it owed. */
export function seamCasesFrom(machine: typeof emailDrafter, events: AgentLogEntry[]) {
  const cases: { prefix: AgentLogEntry[]; request: AgentTextRequest; recorded: unknown }[] = [];

  for (let at = 1; at <= events.length; at++) {
    const prefix = events.slice(0, at);
    // Strict replay: every entry's recorded state/effect hashes must check out,
    // so a fixture cannot drift away from the machine that produced it.
    const { effects } = verifyReplay(machine, prefix);
    const owed = effects.find((effect) => effect.kind === "text");
    if (!owed) continue;

    // The completion the run actually recorded for that call, if it got one.
    const completion = events[at]?.event as { output?: unknown } | undefined;
    cases.push({ prefix, request: owed.request, recorded: completion?.output });
  }

  return cases;
}
```

- Record once, regress every seam forever. A production run becomes a dataset row per model call.
- `verifyReplay` is what makes the fixture trustworthy: it replays with `verify: 'strict'`, so an entry whose recorded state or owed-effect hashes no longer match the machine throws `AgentReplayDivergenceError` instead of silently scoring a stale path. Change the machine, and the fixtures tell you.
- `owed.request` is the full `AgentTextRequest` (system, prompt, messages, schema). Feed it to a candidate model directly for a single-call eval, or use `prefix` as the starting log for a routed-executor run that scores the trajectory after the seam.
- `recorded` is the previous model's answer for that seam, so the dataset ships with a baseline to score against.

## Pairing with observability

Evals score runs offline; tracing watches them in production. They share the machine's trace stream, so a vendor with an OTLP endpoint (Braintrust, LangSmith, Langfuse, Honeycomb) receives spans from `@statelyai/agent/otel` while the same runs are scored here. Neither side needs the other, and neither requires a vendor-specific adapter in your machine. See [Observability](observability.md).
