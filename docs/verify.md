---
title: Testing and verification
description: Statically lint, simulate, and explore agent machines without any API keys or model calls.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

This page covers the APIs that check an agent machine before it runs. None of them need an API key or a model call.

- `lintAgentMachine` statically catches dead states, undeliverable decisions, and output-contract gaps. Pass `{ throw: true }` for the throwing form.
- `assertAgentMachine` is the one-line throwing form for tests and generation loops.
- `simulateAgent` drives a deterministic scripted playthrough to a known outcome.
- `explorePaths` and `canReach` enumerate decision branches and check that a target state is reachable.

Use these APIs to check that an LLM-generated machine is legal before you run it. See [authoring from scratch](quickstart.md). You can also use them to confirm that a refactor preserved behavior, so a machine converted [from a loop](from-a-loop.md) is safe to ship.

> **Note:** Everything on this page runs on `machine.config` and the pure step path, with no provider, no network, and no keys. It is deterministic, so these checks work as ordinary unit tests in any test runner, such as vitest or jest, and as CI checks.

## Machine linting

<!-- lintAgentMachine, assertAgentMachine, and related options from src/verify.ts -->

`lintAgentMachine(machine, options?)` runs static structural checks over a built machine. It accepts machines authored in TypeScript with `setupAgent(...).createMachine(...)` and machines compiled with `setupAgent.fromConfig(...)`. It returns `AgentLintDiagnostic[]`, where each diagnostic is `{ code, severity, path, message }`. The array is empty when the machine is clean.

```ts
import { lintAgentMachine } from "@statelyai/agent";

const errors = lintAgentMachine(machine).filter((d) => d.severity === "error");
if (errors.length) {
  throw new Error(errors.map((e) => `${e.path}: ${e.message}`).join("\n"));
}
```

To throw instead of returning findings, call `assertAgentMachine(machine, options?)`
or pass `{ throw: true }` to `lintAgentMachine`. Both are silent when clean and
throw `AgentLintError` on error-severity findings, with the findings on
`.diagnostics`. Add `warnings: true` to fail on warnings too. Pass `disable` to
skip checks by code.

```ts no-check
assertAgentMachine(machine, { warnings: true });
```

| Code                       | Severity | Fires when                                                                                                                                                                                                                                                                         |
| -------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unreachable-state`        | error    | A state that no transition, `always`, `choice`, `onDone`, or `onError` can reach from the initial state. The check is conservative. Dynamic function transitions over-approximate, so it never reports a false positive. It is exact for `fromConfig` machines, because the lowering retains their declared targets.                 |
| `decide-without-events`    | error    | A state invokes `agent.decide` but neither it nor any ancestor handles any event, so the chosen event can never be delivered.                                                                                                                                                      |
| `unserializable-context`   | warning  | The context schema exposes no JSON schema, for example a `z.custom` messages array, so its fields cannot be checked statically for JSON persist and resume.                                                                                                                                   |
| `direct-object-src`        | warning  | An invoke `src` is a direct object or machine value that `runAgent` cannot rebind, so it inherits no host executors.                                                                                                                                                            |
| `final-without-output`     | error    | The machine declares an output schema but a top-level final state has no `output`.                                                                                                                                                                                                 |
| `final-output-reads-event` | warning  | A top-level final state's `output` function reads the entering `event`. Final `output` functions are evaluated more than once with different events, so `event` is unreliable. Read `context` only, and capture what you need into context in the transition that targets the final state. |
| `undeclared-event`         | warning  | A state handles an event in `on:` that is not declared in `schemas.events` and is not a builtin or wildcard pattern. Its payload stays unvalidated. This is usually a typo. The check is skipped when the machine declares no events.                                                               |
| `missing-final`            | warning  | The machine has no reachable final state, so it can only idle or loop. This is legal, but flagged.                                                                                                                                                                                                     |

## Test assertions

Every check is a plain function, so you can assert structural soundness, reachability, and scripted playthroughs directly in vitest or jest.

```ts no-check
import { assertAgentMachine, canReach, simulateAgent } from "@statelyai/agent";
import { supportMachine } from "./support-machine";

test("machine is structurally sound", () => {
  assertAgentMachine(supportMachine);
});

test("escalation is reachable", async () => {
  const { reachable } = await canReach(supportMachine, "escalated", {
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

Guards stay in force throughout. `canReach` and `simulateAgent` walk the same step path that `runAgent` uses, so a graph path that a guard rejects never counts as reachable. These tests pin the machine's shape as prompts and models change.

## Deterministic executors

Executors are plain functions, so a test can supply scripted executors and never touch the network. Bind them onto a logic with `.withExecutor(...)`.

```ts no-check
const machine = emailDrafter.provide({
  actors: {
    draftEmail: draftEmail.withExecutor(async ({ request }) => {
      return { output: { to: "sam@example.com", subject: "Hello", body: "Hi Sam!" } };
    }),
  },
});
```

[examples/email-drafter/agent-logic.ts](../examples/email-drafter/agent-logic.ts) drives a full run this way, with fixed values and no model call.

Use deterministic executors when the test should exercise the real `runAgent` path with canned model output. Use [`simulateAgent`](#scripted-playthroughs) when a scripted playthrough on the pure step path is enough.

## Scripted playthroughs

`simulateAgent(machine, { input, script, maxSteps? })` runs a deterministic, model-free playthrough on the pure step path. The `script` supplies responses as FIFO queues, so runs are reproducible.

- `decisions` holds the `ChosenEvent` to apply per decision, keyed by decision src, usually `agent.decide`.
- `text` holds output values for text requests, keyed by request src.
- `invokes` holds answers for scripted invokes, keyed by invoke src.
- `userInput` is one flat queue of answers for `agent.userInput` invokes.

```ts
import { simulateAgent } from "@statelyai/agent";

const { status, snapshot, trail } = await simulateAgent(machine, {
  input: { questionsRemaining: 20 },
  script: {
    decisions: { "agent.decide": [{ type: "GUESS", guess: "a cat" }] },
    userInput: ["yes", "no"],
    text: {
      classifyGuessFeedback: [{ correct: true, reasoning: "matched" }],
      classifyPlayAgain: [{ playAgain: false, reasoning: "stop" }],
    },
  },
});
// status: 'done' | 'idle' | 'exhausted'
```

`simulateAgent` returns `{ status, snapshot, trail }`. The status is one of three values:

- `'done'`: the machine reached a final state.
- `'idle'`: the machine came to rest waiting on an external event that the script does not supply.
- `'exhausted'`: the playthrough hit the `maxSteps` bound, which defaults to 100, before reaching either of the above. Raise `maxSteps` or shorten the script.

For a `'done'` run, the output is on `snapshot.output`. The snapshot is typed as the generic `AnyMachineSnapshot`, so the output needs a cast to your output type.

```ts
if (result.status === "done") {
  const output = result.snapshot.output as { correct: boolean };
}
```

> **Note:** When a script queue runs dry mid-request, `simulateAgent` throws a descriptive error naming the pending request's kind, src, and id.

## Branch exploration

`explorePaths(machine, { input, maxDepth?, maxPaths?, text?, invokes?, userInput? })` enumerates decision and external-event branches without a model, and reports coverage.

- At each decision, it forks one branch per candidate event. Guard-rejected candidates count in `prunedByGuard` and are not explored.
- At an idle wait, it forks one branch per externally accepted event.
- `text` is a map of canned outputs for text requests, keyed by src. One value per src is reused every time that src is reached.
- `invokes` is the same map for scripted invokes, and `userInput` is the shorthand for `invokes['agent.userInput']`.
- A src with no canned output halts that branch with a `needs-output` terminal instead of throwing. The terminal's `missingSrc` names it.

<!-- viz: branch exploration tree for the refund machine: deciding -> AUTO_APPROVE (pruned by guard) / NEEDS_REVIEW -> awaitingHuman -> refunded, denied -->


```ts
import { explorePaths } from "@statelyai/agent";

const report = await explorePaths(refundMachine, {
  input: { request: "Refund my duplicate charge", amount: 5000 },
});
// report.terminals   → both 'refunded' and 'denied'
// report.prunedByGuard → 1 (AUTO_APPROVE guarded off for amount > 100)
// report.reachedStates → ['deciding', 'awaitingHuman', 'refunded', 'denied']
```

Exploration is bounded by `maxDepth`, which defaults to 8, and `maxPaths`, which defaults to 200. `report.hitPathCap` is true when the report is partial.

## Reachability checks

<!-- canReach contract from src/verify.ts -->

`canReach(machine, target, opts)` wraps `explorePaths` to answer whether a state
path or state-node ID is reachable, with a witness path when it is.

```ts
import { canReach } from "@statelyai/agent";

const { reachable, witness } = await canReach(refundMachine, "denied", {
  input: { request: "x", amount: 5000 },
});
// reachable → true; witness → [{ type: 'NEEDS_REVIEW' }, { type: 'DENY' }]
```

`witness` is the sequence of chosen and applied events that reaches the state, which is the proof that it is reachable. It is absent when `reachable` is `false`.

## CI checks

Everything on this page runs without an API key, so a small script is enough for CI or a generation loop.

```ts no-check
// check.ts (run with: npx tsx check.ts)
import { assertAgentMachine } from "@statelyai/agent";
import { machine } from "./machine";

assertAgentMachine(machine); // throws AgentLintError on error-severity findings
```

For machines authored as data, validate the config with `validateAgentConfig(config)` from `@statelyai/agent/validate` first, then compile it and lint the machine: `assertAgentMachine(setupAgent.fromConfig(config, { compileSchema }).machine)`. See [Machines as data](machines-as-data.md). Every check applies, including reachability. The lowering keeps the config's transition targets, so `unreachable-state` reads the real graph even where the JSON layer folds a target into a resolver function.

## Related

- [Debugging](debugging.md): scripted reproduction and the diagnostic codes in context.
- [Evals](evals.md): scoring runs on output, trajectory, and budget.
- [Hosts and executors](hosts.md#scripted-executors): keyless scripted executors for `runAgent`.
- [Machines as data](machines-as-data.md): verifying a machine lowered from a config.
- [Migrating from a hand-rolled loop](from-a-loop.md): pinning behavior across a refactor.
- [examples/verification](../examples/verification/index.ts): every API on this page run over one refund-approval machine, keyless, including `canReach` proving that an over-limit payout without human approval is unreachable.
