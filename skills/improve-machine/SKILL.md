---
name: improve-machine
description: Improve a @statelyai/agent policy machine (a TypeScript setupAgent machine or a JSON AgentWorkflowConfig) from its run traces toward its goal, inside a fixed environment machine, with gates and a held-out promotion rule, and hand the result to a person as a pull request. Use when asked to "improve this agent", "self-improve", "optimize the playbook from traces", "tune the policy", "make the agent cheaper or more accurate", or "why is my agent failing" for a machine whose runs are persisted to an event log store.
---

# Improve an agent machine

You improve a **policy**: the machine that decides how the agent works toward its goal, written in TypeScript or as a JSON `AgentWorkflowConfig`. It runs inside an **environment**: a TypeScript machine whose states and guards encode the rules of the world and the business invariants. One round changes the policy once and measures it:

```
locate inputs → read traces → diagnose → propose one diff → gate (≤ 3 repairs) → replay train → replay held-out → recommend or discard → record → pull request
```

This is step 4 of 4, after `loop-to-machine`, `add-traces`, and `add-evals`. To author a JSON policy from scratch, use the `generate-machine` skill. Concept page: [Environment and policy](https://github.com/statelyai/agent/blob/main/docs/environment-and-policy.md).

## Hard rules

- **Never edit the environment.** Not its states, guards, invariants, event schemas, or the vocabulary it exposes. When the goal is unreachable without an environment change, write a change request for a person (template in [reference.md](reference.md)) and stop.
- **Never edit a machine while it runs.** A promoted policy applies to new runs only.
- **The objective comes from ground truth.** Score outcomes from the traces (terminal states, outputs) or from effects recorded in the world. Never ask a model to grade its own runs.
- **One cause per round, smallest diff.** A diff that fixes two things cannot tell you which one helped.
- **Diagnose from training scenarios only.** Held-out scenarios are for the promotion decision. Never read their failures to shape a change, and never move a scenario between splits. Eval files may list baseline failures for every split; read only the training rows.
- **Stop after 3 rounds without a promotion** (or the limit the user gives).
- **Propose, never promote.** A round ends in a recommendation. A recommended candidate goes to a person as a pull request with its scorecard; merging it is the promotion. Never merge, deploy, or switch the running policy yourself.

## Policy format

The rounds are the same for both formats. What differs is what the diff may touch and how it is gated.

| | TypeScript policy | JSON policy |
| --- | --- | --- |
| The policy | A `setupAgent` machine in its own file(s), with a declared `version` | An `AgentWorkflowConfig` file |
| May change | The policy file(s) and their `CHANGELOG.md`; once, the line in the runner that routes the decision to the policy; tests that pin measured numbers (see the pull request) | The config's `states` and `context` |
| Gates | `tsc`, `lintAgentMachine`, `explorePaths` on the policy, the environment check, the overfit check | `verifyAgentConfig` |
| Vocabulary | What the policy file imports and the events the environment offers | The `allow` lists |

**No policy yet.** `loop-to-machine` leaves a single model decision inside the environment when the old code had no policy logic. Then:

- Record `v0` in a new `CHANGELOG.md` next to the environment (in a `policy/` directory): "the model decides directly". This entry goes in the working tree.
- The first recommended candidate introduces the policy as `v1`: a policy file that reproduces the current behavior (it passes the environment's prompt and facts through to the model) plus the one rule the diagnosis found, and the routing line in the runner (`withPolicy(modelExecutors)`). The pattern is in `../loop-to-machine/policy.md`.
- Its `description` is the environment's goal with measurable success criteria. If the environment's goal has none, draft them from the confirmed objective and list the draft under questions for the user.
- If the policy needs a fact the environment does not pass in the decision's `metadata.facts`, that is an environment change request.

For a TypeScript policy, before the first round:

- **List the environment files** (the environment machine, its guards, the world and its tools) and record a hash of each. Any change to them fails the round. The runner is not one of them, but its diff may contain only the routing line.
- **Keep the policy a machine.** A diff may add states, `choice` branches, guards over facts, helpers in the policy file, or change a prompt or a model ref. It may not turn the policy into a free function, call tools the environment owns, or import from the environment anything but its schemas, types, constants, and exported guard functions.

## 1. Locate the inputs

Find all six before changing anything. If one is missing, stop and ask.

| Input          | Where to look                                                                                    | If missing                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Goal           | Root `description` of the policy config or the environment machine                               | Draft one with measurable success criteria; ask the user to confirm it      |
| Objective      | A scorer over outcomes (an eval file, a `score*` function, a benchmark)                          | Write one from the goal's success criteria; **ask the user to confirm it**  |
| Traces         | The `store` passed to `createAgentRuntime` / `runAgent`; its `listThreads`, or recorded ids      | Wire a store first (the `add-traces` skill) and collect runs                |
| Scenarios      | A scenario list with expected outcomes, split into train and held-out                            | Propose a fixed split (about 70/30, every category in both); ask to confirm |
| Vocabulary     | The actors, requests, named guards, actions, decision events, and model refs the host implements | Read them off the host code; never invent names                             |
| Policy history | The policy files and a `CHANGELOG.md` next to them                                               | Create the changelog with the current policy as `v0`                        |

The objective defines "better". Do not start a round until the user has confirmed it, including how two versions compare when it has more than one field. A good objective has:

- a primary metric from the goal (accuracy against expected outcomes and effects, resolution rate). With several, state the rule: one primary, or none worse and one better,
- a hard constraint: invariant violations, which must be 0,
- a cost term (model calls, tokens, guard rejections) used as a tie-breaker or a stated budget. Count the calls that reach a model executor, not the environment's decision requests: a policy that answers with a rule makes no model call, and a cost term that counts requests cannot see the saving.

## 2. Read

Read both machines as text. `describeMachine` puts the goal first:

```ts
import { describeMachine, setupAgent } from "@statelyai/agent";

// A TypeScript policy: import it. A JSON policy: lower it.
const { machine: policy } = setupAgent.fromConfig(policyConfig, { compileSchema });
const environmentText = describeMachine(environment);
const policyText = describeMachine(policy);
```

Then find the training threads and compute one outcome row per episode:

```ts
import { getDecisionAttempts, getUsageFromEvents, replay } from "@statelyai/agent/log";

// Thread ids name the split and policy version: "train:v<n>:<scenario>:r<k>".
const prefix = `train:v${currentVersion}:`;
const threadIds: string[] = [];
let cursor: string | undefined;
do {
  const page = await store.listThreads!({ prefix, limit: 100, cursor });
  threadIds.push(...page.threadIds);
  cursor = page.cursor;
} while (cursor !== undefined);

const rows = [];
for (const threadId of threadIds) {
  const scenario = scenarioOf(threadId);
  const entries = await store.read(threadId);
  const { snapshot } = replay(environment, entries); // the recording machine; pure fold, no model calls
  rows.push({
    threadId,
    expected: scenario.expected,
    state: snapshot.value,
    status: snapshot.status,
    output: snapshot.output,
    steps: entries.length,
    tokens: getUsageFromEvents(entries).totalTokens ?? 0,
    failedAttempts: getDecisionAttempts(entries).flatMap(({ attempts }) => attempts),
  });
}
```

- `store.listThreads({ prefix, limit, cursor })` pages through the threads that hold at least one entry. `cursor` is present only while more ids remain. It is optional on a custom `AgentEventLogStore`; `createInMemoryEventLogStore` implements it. Without it, use the thread ids recorded with each scenario.
- Prefix thread ids with the split and version so a `listThreads` prefix returns one version's training runs and never a held-out thread. `scenarioOf` is your mapping from a thread id back to its scenario.
- `store.read(threadId)` returns a thread's entries in log order.
- `replay(machine, entries)` needs the machine, at the version, that recorded the thread. Here that is the environment: its runtime records every thread, and the policy runs only as a decider at its boundary, so never replay with the policy machine. A thread recorded by a different environment version throws `AgentMachineVersionMismatchError`. Score each thread with the version that recorded it.
- `getDecisionAttempts(entries)` returns `{ index, eventType, attempts }` for each entry whose decision needed retries: the failed tries before the event landed, or every try of an exhausted decision (`eventType` is then `xstate.error.actor.*`). Each attempt has `failure` (`unknown-event`, `invalid-payload`, or `rejected-by-guard`), `reason`, and the attempted `event` when there was one. A first-try decision records nothing.
- `agent.decide` invokes journal their attempts on their own. With `decideNext` at the boundary, the host must pass them with the event, `runToQuiescence(runtime, { event, attempts })` or `runtime.transition(state, event, { attempts })`, or they never reach the log.
- Compute the objective over the rows. This is the baseline for the round.

## 3. Diagnose

Group the failing training episodes by cause. Check these clusters in order:

1. **Invariant violations.** Any violation is a stop: the environment is wrong, not the policy. Write a change request.
2. **Wrong terminal state.** The episode ended in `escalated` when the label says `issued`, or the reverse. Look at which decision led there.
3. **Right terminal state, wrong effect.** The episode ended `issued` with the wrong amount, or reached the right state by a costlier path. Compare the chosen event with the offered options at each decision.
4. **Guard rejections.** The policy keeps proposing events the environment refuses: `rejected-by-guard` entries in the rows' `failedAttempts`. The policy lacks a check the environment already makes.
5. **Loops and budget exhaustion.** Repeated state values, or a terminal reached because a turn or retry budget ran out.
6. **Cost hotspots.** Correct episodes that spend model calls where a `choice` over known facts, or a cheap judgment, would decide.

Pick the cluster with the largest effect on the objective. Write the hypothesis down before you edit anything (template in [reference.md](reference.md)): cause, evidence (thread ids), the change, and which metric should move.

## 4. Propose

Make the smallest policy diff that addresses the one cause.

- Typical diffs: add a `choice` branch over facts already in context; replace a model call with a judgment actor from the vocabulary; narrow an `agent.decide` `allowedEvents` list; turn an open decision into a closed choice with `payloads`; tighten a prompt; add an `onError` path; lower a model ref to a cheaper one in the vocabulary.
- TypeScript policy: compare facts directly in a guard or `choice` instead of adding a named guard; keep helpers in the policy file.
- JSON policy: use only names in the vocabulary. A named guard the host does not implement fails the `lower` gate.
- Keep the machine `id`. Bump `version`.
- Keep the root `description` (the goal) unchanged. Changing the goal is the user's decision.

## 5. Gate

### TypeScript policy

Run every check; a failure's output is the repair prompt. Cap repairs at 3.

1. **Environment unchanged:** every environment file hashes as recorded. A change is never repaired; discard the candidate.
2. **Types:** `tsc --noEmit` passes.
3. **Lint:** `lintAgentMachine(policy)` from `@statelyai/agent/testing` reports no errors.
4. **Paths:** for probe inputs built from recorded decision requests (one per training scenario that reaches the decision: its facts and offered options), `canReach(policy, (snapshot) => snapshot.status === "done" && !isOfferedEvent(snapshot.output), { input })` is `{ reachable: false, complete: true }`: every final output is one of the offered events. Pass `outputs` for any actor the policy invokes, and `errors: { "agent.decide": new Error("down") }` so the fallback path is checked too.
5. **Source rules:** the policy file is still one `setupAgent` machine; its imports from the environment are only schemas, types, constants, and exported guard functions; it names no actor the environment owns. These are source checks: read the diff, or grep its imports and actor names.
6. **Overfit:** the diff contains no literal from the scenarios (ids, ticket text, customer ids, order ids). A branch that matches one scenario's data is memorization; discard it.
7. **Existing evals:** the rule and decision evals from `add-evals` still pass. Tests that pin measured numbers of the current version (a baseline failure list, a call count) are expected to change; update them in the same pull request and list each change in its body.

The environment's own `canReach` proofs still cover every policy, because the environment's guards judge every proposed event.

### JSON policy

Run `verifyAgentConfig` from `@statelyai/agent/validate` with the vocabulary and probe inputs. Probe inputs are one input per training scenario category, chosen to reach every branch the diff touches.

```ts
import { verifyAgentConfig } from "@statelyai/agent/validate";

const verified = await verifyAgentConfig(candidate, {
  compileSchema,
  guards: hostGuards,
  actors: hostActors,
  allow: { actors, requests, guards, actions, events, models },
  explore: {
    inputs: probeInputs,
    terminals: ["done"],
    // Both outcomes, so the branches on either side of the classifier are probed.
    outputs: {
      classifyTicket: [
        { isRefundRequest: true, confidence: 0.9 },
        { isRefundRequest: false, confidence: 0.9 },
      ],
    },
    errors: { classifyTicket: new Error("down") },
  },
});
const failed = verified.gates.find((gate) => !gate.ok);
```

- Gates run in order and stop at the first failure: `validate`, `vocabulary`, `lower`, `lint`, `explore`.
- A failed gate's `detail` names the offending path, state, or name. Send it back verbatim with the rejected config and regenerate. Cap repairs at 3. After 3, discard the candidate, record it, and move to the next cause.
- `explore` keys besides `inputs` and `terminals` pass through to `explorePaths`: `outputs` (output lists per src: one element is a canned output, two or more fork one branch each), `errors`, `payloads` (one branch per payload), `dedupeBy` (explore each snapshot key once; the key must cover every field a guard reads), `maxDepth`, `maxPaths`.
- The environment's own `canReach` proofs cover every policy, because the environment's guards judge every proposed event. You did not change the environment, so you do not re-prove it.

## 6. Replay

Run the candidate on the training scenarios, then on the held-out scenarios. Write every replay to the store under new thread ids that name the split and version, in the scheme `add-traces` set up (`train:v3:<scenario>:r1`, `held-out:v3:<scenario>:r1`), so the next round can list them by prefix. With no persistent store, write each thread's `result.events` to a file.

- Run the current policy and the candidate on the same scenarios, the same world state, and the same model refs.
- Model calls are nondeterministic. Run each scenario k times (k ≥ 3 when calls are not cached) and compare means.
- Compute the objective, invariant violations, and cost per split, for both versions.

## 7. Recommend or discard

State the tolerance before you replay. Recommend only when every condition holds:

- invariant violations are 0 on both splits,
- the objective on the held-out split is better than the current policy's,
- no single scenario regresses beyond the tolerance (for example, a scenario that passed in all k runs now fails in any),
- cost stays within the stated budget, if there is one.

Otherwise discard the candidate and keep the current policy. Either way, append an entry to the `CHANGELOG.md` next to the policies: version, hypothesis, diff summary, gate results, before and after per split, and the decision. Record discarded candidates too; they stop the next round from retrying the same idea.

### The pull request

A recommended candidate becomes one pull request (or, with no remote, one branch and a diff file), opened against the repository's integration branch:

- **The diff:** the policy file(s) and the new `CHANGELOG.md` entry; the runner's routing line, when this candidate introduces the policy; and updated pinned measurements, each listed in the body. Nothing else.
- **The body:** the hypothesis, the scorecard (objective, violations, and cost before and after, train and held-out separately, k runs each), every scenario that changed outcome, the gate results, and the thread ids a reviewer can replay.
- **One candidate per pull request.** Leave your working tree on the current policy. Later rounds build on the current policy, not on an unmerged candidate.

## 8. Stop and report

Stop when any of these holds:

- 3 rounds in a row without a promotion,
- the goal's success criteria are met on the held-out split,
- the remaining failures need an environment change (write a change request),
- the vocabulary lacks a capability the fix needs (ask for it; name the actor, request, or guard and its input and output).

Report to the user: rounds run, each candidate with its hypothesis and decision, the pull request link (or, with no remote, the branch and diff file), the objective before and after on both splits, violations, cost, and any change requests.

## Worked example

[`examples/self-improving-refunds`](https://github.com/statelyai/agent/blob/main/examples/self-improving-refunds) in the `statelyai/agent` repo (not in the installed package) runs this loop end to end for a JSON policy:

- the refund desk is the environment: business rules as guards, and an `illegallyIssued` sentinel proven unreachable,
- `playbooks/*.json` are policy versions, with the vocabulary listed in `playbooks/README.md`,
- `improve.ts` is the loop: propose, gate, replay, promote,
- `benchmark.ts` compares a raw tool loop, the desk with a raw model deciding, and the desk with a playbook deciding.

Read the directory before you start. File contents change between releases.
