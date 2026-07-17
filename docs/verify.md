> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

# Verify

Keyless verification for agent machines. Coding agents generate these machines; they need a closed loop to **self-verify what they generated without any API keys or model calls**. `@statelyai/agent` ships three static/simulated APIs plus a thin CLI for that.

Everything here runs on `machine.config` and the pure step path: no provider, no network, no keys.

## Why keyless

An agent that emits a machine (from a prompt, a database, a visual editor) can't trust it blindly. Running it costs model calls and only exercises one path. These APIs let the generator check the machine _structurally_ and _by simulation_ before it ever spends a token:

- catch dead states, undeliverable decisions, and output-contract gaps statically;
- drive a scripted playthrough to a known outcome deterministically;
- enumerate every decision branch and prove a target state is reachable.

## `lintAgentMachine(machine, options?)`

Static structural checks over a built machine, working for TS-authored (`setupAgent(...).createMachine(...)`) and `setupAgent.fromConfig(...)`-compiled machines alike. Returns `AgentLintDiagnostic[]` (`{ code, severity, path, message }`), empty when clean.

```ts
import { lintAgentMachine } from "@statelyai/agent";

const errors = lintAgentMachine(machine).filter((d) => d.severity === "error");
if (errors.length) {
  throw new Error(errors.map((e) => `${e.path}: ${e.message}`).join("\n"));
}
```

For a one-liner that throws instead of returning findings, use `assertAgentMachine(machine, options?)`: silent when clean, throws `AgentLintError` (findings on `.diagnostics`, message formatted like the CLI report) on any error-severity finding. `warnings: true` fails warnings too; `disable` skips checks, same as `lintAgentMachine`.

| Code                       | Severity | Fires when                                                                                                                                                                                                                                                                          |
| -------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unreachable-state`        | error    | A state no transition/`always`/`choice`/`onDone`/`onError` can reach from the initial state. Conservative: dynamic (function) transitions over-approximate, so it never false-flags.                                                                                                |
| `decide-without-events`    | error    | A state invokes `agent.decide`/`agent.plan` but neither it nor any ancestor handles any event, so the chosen event can never be delivered.                                                                                                                                            |
| `unserializable-context`   | warning  | The context schema exposes no JSON schema (e.g. a `z.custom` messages array), so its fields can't be statically checked for JSON persist/resume.                                                                                                                                    |
| `direct-object-src`        | warning  | An invoke `src` is a direct object/machine value that can't be rebound by `runAgent`, so it inherits no host executors.                                                                                                                                                             |
| `final-without-output`     | error    | The machine declares an output schema but a top-level final state has no `output`.                                                                                                                                                                                                  |
| `final-output-reads-event` | warning  | A top-level final state's `output` function reads the entering `event`. Final `output` fns are evaluated more than once with different events, so `event` is unreliable. Read `context` only, capturing what you need into context in the transition that targets the final state. |
| `missing-final`            | warning  | No reachable final state; the machine can only idle/loop (legal, but flagged).                                                                                                                                                                                                     |

## Assert machines in tests

Everything above is a plain function, so a machine is a thing you assert in a unit test: no model, no API key, no mocks. Structural soundness, reachability, and full scripted playthroughs run deterministically in vitest/jest:

```ts
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

Guards stay in force throughout: `canReach` and `simulateAgent` walk the same step path `runAgent` uses, so a path that exists in the graph but is guard-illegal never counts as reachable. Prompts change, models change; these tests pin the shape.

## `await simulateAgent(machine, { input, script, maxSteps? })`

A deterministic, model-free playthrough on the pure step path (async: it drives plan steps through the real durable protocol). The `script` supplies responses by invoke `src` (FIFO queues), so runs are reproducible:

- `decisions`: the `ChosenEvent` to apply for each decision (keyed by decision src, usually `agent.decide`). A plan step is a decision too: key its chosen events by the plan invoke's src (`agent.plan`) and end with the reserved `agent.plan.done` move to complete the plan;
- `text`: output values for text requests (keyed by request src);
- `userInput`: answers for `agent.userInput` invokes.

```ts
import { simulateAgent } from "@statelyai/agent";

const { status, snapshot, trail } = await simulateAgent(machine, {
  input: { questionsRemaining: 20 },
  script: {
    decisions: { "agent.decide": [{ type: "GUESS", guess: "a cat" }] },
    userInput: { "agent.userInput": ["yes", "no"] },
    text: {
      classifyGuessFeedback: [{ correct: true, reasoning: "matched" }],
      classifyPlayAgain: [{ playAgain: false, reasoning: "stop" }],
    },
  },
});
// status: 'done' | 'idle' | 'exhausted'
```

Returns `{ status, snapshot, trail }`. It throws a descriptive error (naming the pending request's kind, src, and id) when the script runs dry mid-request, so a missing response is obvious.

## `await explorePaths(machine, { input, maxDepth?, textOutputs? })`

Enumerates decision and external-event branches, model-free, and reports coverage (async: plan branches advance through the real plan protocol). At each decision request it forks one branch per candidate event (guard-rejected candidates are counted in `prunedByGuard`, not explored); at an idle wait it forks per externally-accepted event. A `agent.plan` request forks the same way (plan steps fork like decisions, including the reserved `agent.plan.done` move, which is always legal while other candidates prune when their guard rejects them), so a single plan can consume several depth units. Text/`userInput` invokes are resolved from `textOutputs` (a by-src canned-output map); a missing src halts that branch with a `needs-output` terminal instead of throwing.

```ts
import { explorePaths } from "@statelyai/agent";

const report = await explorePaths(refundMachine, {
  input: { request: "Refund my duplicate charge", amount: 5000 },
});
// report.terminals   → both 'refunded' and 'denied'
// report.prunedByGuard → 1 (AUTO_APPROVE guarded off for amount > 100)
// report.reachedStates → ['deciding', 'awaitingHuman', 'refunded', 'denied']
```

Bounded by `maxDepth` (default 8) and `maxPaths` (default 200; `report.hitPathCap` flags a partial report).

## `await canReach(machine, statePath, opts)`

Thin wrapper over `explorePaths` answering "can this state be reached?" with a witness path (async).

```ts
import { canReach } from "@statelyai/agent";

const { canReach: ok, witness } = await canReach(refundMachine, "denied", {
  input: { request: "x", amount: 5000 },
});
// ok → true; witness → [{ type: 'NEEDS_REVIEW' }, { type: 'DENY' }]
```

## CLI

For machines authored as data (see [machines as data](machines-as-data)), a thin `statelyai-agent lint` binary lints a JSON config:

```bash
npx statelyai-agent lint workflow.json
```

The library bundles no JSON Schema engine, so the CLI lints **structure only**: it compiles the config with a permissive pass-through compiler and runs `lintAgentMachine`. It exits `1` on any error-severity finding, so drop it into CI or a generation loop. For full schema-aware linting, use the API with a real compiler: `lintAgentMachine(setupAgent.fromConfig(config, { compileSchema }))`.

> Because `fromConfig` lowers every transition to a function, `unreachable-state` is over-approximated for config machines; the other checks are unaffected.
