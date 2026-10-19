# Code-review loop

An author writes a file, self-checks it while an independent reviewer reviews it, and the task's visible tests run. Then the loop ships, retries, or asks a person. The loop is a fixed machine; the triage decision is a JSON policy that improves from its own traces.

```text
generating ─▶ verifying ──────────────────────────▶ checking ─▶ triaging
 ▲ writePatch  ├ selfCheck (selfCheckPatch)          runChecks     ├─ checks ∧ approved ∧ self-check ok ─▶ checkingShip ─▶ shipped
 │             └ review    (reviewPatch, reviewer)                 ├─ round cap ───────────────────────────▶ humanReview
 │                                                                 └─▶ deciding (agent.decide, model "triage" = the policy)
 ├──────────────── RETRY {feedback, focus} ◀─────────────────────────────┤
 │                                           ESCALATE {reason} ─▶ humanReview
 └── REQUEST_CHANGES {notes} ◀── humanReview ── APPROVE ─▶ checkingShip ─▶ shipped
                                      └── REJECT ─▶ rejected
```

- **Environment** (`environment.ts`): the machine above. Shipping is computed, never chosen. The policy can only pick one of the offered RETRY or ESCALATE options. RETRY is refused at the round cap (3), when the reviewer marked an issue `novel`, and when the checks failed outside every visible test. `checkingShip` re-checks every ship; `illegallyShipped` is proven unreachable with `canReach`.
- **Policy** (`policy.ts`, `policies/*.json`): a JSON `AgentWorkflowConfig` run as the decide executor for model `"triage"`. `v0` always retries until the cap. `v1` asks `classifyIssue` whether the review says the task itself is broken and escalates early, and otherwise retries with targeted feedback (the failing tests, or the review).
- **Traces** (`file-store.ts`): every task run is a thread `<split>/<policyVersion>/<taskId>`, one JSONL file per thread.
- **Objective** (`bench.ts`), scored from the final state: shipped with hidden tests passing = 1 (a person's approval counts as a ship, so its hidden tests run too), a correctly escalated novel task = 1, an escalated resolvable task = 0.5 (a person's reject or no answer scores as the escalation), shipped with hidden tests failing = 0, minus 0.05 per round.
- **Tasks** (`tasks.ts`, `fixtures/`): eight tiny modules (`clamp`, `slugify`, `chunk`, `parse-duration`, `round-half`, `truncate`, `capitalize-words`, `merge-config`), each with visible tests (run every round) and hidden tests (run only by the objective). `round-half` and `merge-config` have a spec that contradicts their visible tests, so the right move is to escalate.
- **Improve** (`improve.ts`): reflect on the train traces, gate the candidate with `verifyAgentConfig` and a probe of the real triage boundary, replay train and held-out, and promote only on a strict objective gain with no violation.
- **Before** (`before.ts`): the same factory as a hand-rolled `while` loop, the starting point of [Part 2 of Migrating from a hand-rolled loop](../../docs/from-a-loop.md#part-2-a-factory-loop-that-improves).

## Tests

No keys, no network, no `claude` CLI:

```bash
pnpm vitest run examples/code-review-loop
```

With mock author and reviewer executors, v0 scores 0.900 on train and 0.900 on held-out; v1 scores 0.920 and 0.933, and one improvement round promotes v1.

## Run it with Claude Code

Every author, self-check, reviewer, and classifier call is one headless `claude -p --output-format json` process with tools off, no saved session, and `--safe-mode`. Log in to the CLI first (`claude`, then `/login`).

```bash
pnpm exec tsx examples/code-review-loop/run.ts --task clamp
pnpm exec tsx examples/code-review-loop/run.ts --split train --policy v1
```

- `--task <id>`: one task. Default: every task in `--split`.
- `--split train|held-out|all`: default `all`.
- `--policy <name>`: `policies/<name>.json`. `current` (the default) is the last promoted policy, else `v0`.
- `--model <alias>`: the Claude Code model for every call, such as `sonnet` or `haiku`.
- `--reviewer-model <alias>`: a different model for the reviewer only. Default: the same model as the author. One model keeps cost and setup simple, but then the reviewer is independent only by its prompt and shares the author's blind spots; a different model catches more of the author's mistakes at the cost of a second model's price and behavior.
- `--no-human`: leave escalated tasks waiting. Without it, an escalated task asks on stdin: `a` ships as-is, `r <notes>` requests changes, `x` rejects.

Traces land in `examples/code-review-loop/.traces/<timestamp>/` (gitignored). The run prints a scorecard: outcome, rounds, hidden tests, and score per task, the objective per split, and the call count, cost, and wall time.

## Running generated code

The checks run model-written patches with `node --test`. Each run gets a fresh temp workspace and runs under Node's permission model (Node 22.18+, the repo's floor):

- `--permission` with `--allow-fs-read` and `--allow-fs-write` limited to the workspace. Child processes, worker threads, native addons, and WASI are denied.
- `--test-isolation=none` (`--experimental-test-isolation=none` on Node versions without the stable flag), so the test file runs in the same process instead of a subprocess the permission model would refuse.
- An env holding only `PATH`: no API keys, tokens, or `NODE_OPTIONS` from your shell.
- A 20 s timeout, then `SIGKILL`.
- A run passes only after the reporter prints its results, so a patch that calls `process.exit(0)` fails.

This is not a sandbox. On Node 22 and 24 the permission model does not restrict the network. A patch runs in the same process as its tests, so it can tamper with them. It can also use CPU and memory until the timeout. Run untrusted output in a container or VM.

## Improve the policy

Each improvement round runs every task twice (current policy, then candidate), so expect about 100 Claude Code calls.

### With the built-in loop

```bash
pnpm exec tsx examples/code-review-loop/run.ts --improve --policy v0
```

It runs train and held-out with v0, asks Claude Code for a better policy from the goal, the objective, both machines, and the train trails, runs the gates, replays both splits, and writes a promoted policy to `policies/current.json` (gitignored).

### Inside Claude Code, with the improve-machine skill

Make the skill available to Claude Code, then ask for one round:

```bash
mkdir -p .claude/skills && cp -R skills/improve-machine .claude/skills/
pnpm exec tsx examples/code-review-loop/run.ts --policy v0 --no-human
claude -p "Use the improve-machine skill on examples/code-review-loop. The environment is codeReviewLoopMachine in examples/code-review-loop/environment.ts: never edit it. The current policy is examples/code-review-loop/policies/v0.json, and its vocabulary is in policy.ts (the classifyIssue actor, agent.decide with model 'policy', events RETRY and ESCALATE). The traces are the JSONL threads in the newest directory under examples/code-review-loop/.traces/, named <split>/<policyVersion>/<taskId>; diagnose from train threads only. The objective is scoreEpisode in bench.ts, as OBJECTIVE_TEXT in improve.ts states it; I confirm it. Write one candidate to examples/code-review-loop/policies/v2.json with a new id, check it with pnpm vitest run examples/code-review-loop, replay it with pnpm exec tsx examples/code-review-loop/run.ts --policy v2 --no-human, and copy it to policies/current.json only if the held-out objective rises with zero violations. Report the before and after scorecards." \
  --allowedTools "Read,Write,Edit,Bash(pnpm exec tsx examples/code-review-loop/run.ts:*),Bash(pnpm vitest run examples/code-review-loop:*)"
```

## In the demo

`codeReviewLoopMachine` is the demo machine. Its `runChecks` actor runs the real visible tests with `node --test`, and `humanReview` renders as buttons (ship as-is, reject) plus a text box for requested changes.
