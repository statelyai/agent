---
title: Testing and verification
description: Statically lint, simulate, and explore agent machines without any API keys or model calls.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

Three APIs check an agent machine before it runs, with no API key or model call:

- `lintAgentMachine` catches dead states, undeliverable decisions, and output-contract gaps statically.
- `simulateAgent` drives a scripted playthrough to a known outcome deterministically.
- `explorePaths` / `canReach` enumerate every decision branch and prove a target state is reachable.

Use them to prove an LLM-generated machine is legal before you run it ([authoring from scratch](quickstart.md)), or to pin that a refactor preserved behavior, so a machine converted [from a loop](from-a-loop.md) is safe to ship.

> **Note:** Everything on this page runs on `machine.config` and the pure step path: no provider, no network, no keys. It is deterministic, so these are ordinary unit tests in any test runner (vitest, jest) and CI checks.

## Machine linting

The `lintAgentMachine(machine, options?)` function runs static structural checks over a built machine, for TS-authored (`setupAgent(...).createMachine(...)`) and `setupAgent.fromConfig(...)`-compiled machines alike. It returns `AgentLintDiagnostic[]` (`{ code, severity, path, message }`), empty when clean.

```ts
import { lintAgentMachine } from "@statelyai/agent";

const errors = lintAgentMachine(machine).filter((d) => d.severity === "error");
if (errors.length) {
  throw new Error(errors.map((e) => `${e.path}: ${e.message}`).join("\n"));
}
```

For a one-liner that throws instead of returning findings, use `assertAgentMachine(machine, options?)`: silent when clean, throws `AgentLintError` (findings on `.diagnostics`) on any error-severity finding. `warnings: true` fails warnings too; `disable` skips checks, same as `lintAgentMachine`.

| Code                       | Severity | Fires when                                                                                                                                                                                                                                                                         |
| -------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unreachable-state`        | error    | A state no transition/`always`/`choice`/`onDone`/`onError` can reach from the initial state. Conservative: dynamic (function) transitions over-approximate, so it never false-flags. Exact for `fromConfig` machines, whose declared targets the lowering retains.                 |
| `decide-without-events`    | error    | A state invokes `agent.decide`/`agent.plan` but neither it nor any ancestor handles any event, so the chosen event can never be delivered.                                                                                                                                         |
| `unserializable-context`   | warning  | The context schema exposes no JSON schema (e.g. a `z.custom` messages array), so its fields can't be statically checked for JSON persist/resume.                                                                                                                                   |
| `direct-object-src`        | warning  | An invoke `src` is a direct object/machine value that can't be rebound by `runAgent`, so it inherits no host executors.                                                                                                                                                            |
| `final-without-output`     | error    | The machine declares an output schema but a top-level final state has no `output`.                                                                                                                                                                                                 |
| `final-output-reads-event` | warning  | A top-level final state's `output` function reads the entering `event`. Final `output` fns are evaluated more than once with different events, so `event` is unreliable. Read `context` only, capturing what you need into context in the transition that targets the final state. |
| `undeclared-event`         | warning  | A state handles an event in `on:` that isn't declared in `schemas.events` and isn't a builtin/wildcard pattern. Its payload stays unvalidated; usually a typo. Skipped entirely when the machine declares no events.                                                               |
| `missing-final`            | warning  | No reachable final state; the machine can only idle/loop (legal, but flagged).                                                                                                                                                                                                     |

## Test assertions

Every check is a plain function, so assert structural soundness, reachability, and scripted playthroughs directly in vitest/jest:

```ts no-check
import { assertAgentMachine, canReach, simulateAgent } from "@statelyai/agent";
import { supportMachine } from "./support-machine";

test("machine is structurally sound", () => {
  assertAgentMachine(supportMachine); // throws AgentLintError with findings
});

test("escalation is reachable", async () => {
  const { canReach: reachable } = await canReach(supportMachine, "escalated", {
    input: { question: "refund?" },
  });
  expect(reachable).toBe(true);
});

test("happy path settles done", async () => {
  const result = await simulateAgent(supportMachine, {
    input: { question: "refund?" },
    script: { decisions: { "agent.decide": [{ type: "RESOLVE" }] } },
  });
  expect(result.status).toBe("done");
});
```

Guards stay in force throughout: `canReach` and `simulateAgent` walk the same step path `runAgent` uses, so a graph path that is guard-illegal never counts as reachable. These tests pin the shape as prompts and models change.

## Deterministic executors

Executors are plain functions, so a test supplies scripted ones and never touches the network. Bind them onto a logic with `.withExecutor(...)`:

```ts no-check
const machine = emailDrafter.provide({
  actors: {
    draftEmail: draftEmail.withExecutor(async ({ request }) => {
      return { output: { to: "sam@example.com", subject: "Hello", body: "Hi Sam!" } };
    }),
  },
});
```

[examples/email-drafter/agent-logic.ts](../examples/email-drafter/agent-logic.ts) drives a full run this way: fixed values, deterministic, no model called.

Use this when the test should exercise the real `runAgent` path with canned model output; use `simulateAgent` below when a scripted playthrough on the pure step path is enough.

## Scripted playthroughs

The `simulateAgent(machine, { input, script, maxSteps? })` call runs a deterministic, model-free playthrough on the pure step path (async: it drives plan steps through the real durable protocol). The `script` supplies responses by invoke `src` (FIFO queues), so runs are reproducible:

- `decisions`: the `ChosenEvent` to apply per decision (keyed by decision src, usually `agent.decide`). A plan step is a decision too: key its chosen events by the plan src (`agent.plan`) and end with the reserved `agent.plan.done` move to complete the plan;
- `text`: output values for text requests (keyed by request src);
- `invokes`: answers for `agent.userInput` invokes.

```ts
import { simulateAgent } from "@statelyai/agent";

const { status, snapshot, trail } = await simulateAgent(machine, {
  input: { questionsRemaining: 20 },
  script: {
    decisions: { "agent.decide": [{ type: "GUESS", guess: "a cat" }] },
    invokes: { "agent.userInput": ["yes", "no"] },
    text: {
      classifyGuessFeedback: [{ correct: true, reasoning: "matched" }],
      classifyPlayAgain: [{ playAgain: false, reasoning: "stop" }],
    },
  },
});
// status: 'done' | 'idle' | 'exhausted'
```

It returns `{ status, snapshot, trail }`. For a `'done'` run the output lives on `snapshot.output`, typed as the generic `AnyMachineSnapshot`, so it needs a cast to your output type:

```ts
if (result.status === "done") {
  const output = result.snapshot.output as { correct: boolean };
}
```

> **Note:** When the script runs dry mid-request, `simulateAgent` throws a descriptive error naming the pending request's kind, src, and id, so a missing response is obvious.

## Branch exploration

The `explorePaths(machine, { input, maxDepth?, textOutputs? })` call enumerates decision and external-event branches, model-free, and reports coverage (async: plan branches advance through the real plan protocol).

- At each decision it forks one branch per candidate event. Guard-rejected candidates count in `prunedByGuard` and are not explored.
- At an idle wait it forks per externally-accepted event.
- An `agent.plan` request forks the same way (including the reserved `agent.plan.done` move, always legal), so a single plan can consume several depth units.
- Text/`userInput` invokes resolve from `textOutputs` (a by-src canned-output map); a missing src halts that branch with a `needs-output` terminal instead of throwing.

```ts
import { explorePaths } from "@statelyai/agent";

const report = await explorePaths(refundMachine, {
  input: { request: "Refund my duplicate charge", amount: 5000 },
});
// report.terminals   → both 'refunded' and 'denied'
// report.prunedByGuard → 1 (AUTO_APPROVE guarded off for amount > 100)
// report.reachedStates → ['deciding', 'awaitingHuman', 'refunded', 'denied']
```

Exploration is bounded by `maxDepth` (default 8) and `maxPaths` (default 200; `report.hitPathCap` flags a partial report).

## Reachability checks

The `canReach(machine, statePath, opts)` call wraps `explorePaths` to answer "can this state be reached?" with a witness path (async).

```ts
import { canReach } from "@statelyai/agent";

const { canReach: ok, witness } = await canReach(refundMachine, "denied", {
  input: { request: "x", amount: 5000 },
});
// ok → true; witness → [{ type: 'NEEDS_REVIEW' }, { type: 'DENY' }]
```

## CI checks

Everything on this page runs without an API key, so a small script is enough for CI or a generation loop:

```ts no-check
// check.ts (run with: npx tsx check.ts)
import { assertAgentMachine } from "@statelyai/agent";
import { machine } from "./machine";

assertAgentMachine(machine); // throws AgentLintError on error-severity findings
```

For machines authored as data (see [machines as data](machines-as-data.md)), compile the config first: `assertAgentMachine(setupAgent.fromConfig(config, { compileSchema }).machine)`. Every check applies, reachability included: the lowering keeps the config's transition targets, so `unreachable-state` reads the real graph even where the JSON layer folds a target into a resolver function.
