---
name: improve-machine
description: Improve a @statelyai/agent policy machine (a JSON AgentWorkflowConfig) from its run traces toward its goal, inside a fixed environment machine, with gates and a held-out promotion rule. Use when asked to "improve this agent", "self-improve", "optimize the playbook from traces", "tune the policy", "make the agent cheaper or more accurate", or "why is my agent failing" for a machine whose runs are persisted to an event log store.
---

# Improve an agent machine

You improve a **policy**: the JSON `AgentWorkflowConfig` that decides how the agent works toward its goal. It runs inside an **environment**: a TypeScript machine whose states and guards encode the rules of the world and the business invariants. One round changes the policy once and measures it:

```
locate inputs → read traces → diagnose → propose one diff → verifyAgentConfig (≤ 3 repairs) → replay train → replay held-out → promote or discard → record
```

To author a policy from scratch, use the `generate-machine` skill. Concept page: `docs/environment-and-policy.md`.

## Hard rules

- **Never edit the environment.** Not its states, guards, invariants, event schemas, or the vocabulary it exposes. When the goal is unreachable without an environment change, write a change request for a person (template in [reference.md](reference.md)) and stop.
- **Never edit a machine while it runs.** A promoted policy applies to new runs only.
- **The objective comes from ground truth.** Score outcomes from the traces (terminal states, outputs) or from effects recorded in the world. Never ask a model to grade its own runs.
- **One cause per round, smallest diff.** A diff that fixes two things cannot tell you which one helped.
- **Diagnose from training scenarios only.** Held-out scenarios are for the promotion decision. Never read their failures to shape a change, and never move a scenario between splits.
- **Stop after 3 rounds without a promotion** (or the limit the user gives).

## 1. Locate the inputs

Find all six before changing anything. If one is missing, stop and ask.

| Input          | Where to look                                                                                    | If missing                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Goal           | Root `description` of the policy config or the environment machine                               | Draft one with measurable success criteria; ask the user to confirm it      |
| Objective      | A scorer over outcomes (an eval file, a `score*` function, a benchmark)                          | Write one from the goal's success criteria; **ask the user to confirm it**  |
| Traces         | The `store` passed to `createAgentRuntime` / `runAgent`; its `listThreads`, or recorded ids      | Wire a store first (see `generate-machine` step 6) and collect runs         |
| Scenarios      | A scenario list with expected outcomes, split into train and held-out                            | Propose a fixed split (about 70/30, every category in both); ask to confirm |
| Vocabulary     | The actors, requests, named guards, actions, decision events, and model refs the host implements | Read them off the host code; never invent names                             |
| Policy history | The policy files and a `CHANGELOG.md` next to them                                               | Create the changelog with the current policy as `v0`                        |

The objective defines "better". Do not start a round until the user has confirmed it. A good objective has:

- a primary metric from the goal (accuracy against expected outcomes, resolution rate),
- a hard constraint: invariant violations, which must be 0,
- a cost term (model calls, tokens, guard rejections) used as a tie-breaker or a stated budget.

## 2. Read

Read both machines as text. `describeMachine` puts the goal first:

```ts
import { describeMachine, setupAgent } from "@statelyai/agent";

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
3. **Guard rejections.** The policy keeps proposing events the environment refuses: `rejected-by-guard` entries in the rows' `failedAttempts`. The policy lacks a check the environment already makes.
4. **Loops and budget exhaustion.** Repeated state values, or a terminal reached because a turn or retry budget ran out.
5. **Cost hotspots.** Correct episodes that spend model calls where a `choice` over known facts, or a cheap judgment, would decide.

Pick the cluster with the largest effect on the objective. Write the hypothesis down before you edit anything (template in [reference.md](reference.md)): cause, evidence (thread ids), the change, and which metric should move.

## 4. Propose

Make the smallest policy diff that addresses the one cause.

- Typical diffs: add a `choice` branch over facts already in context; replace a model call with a judgment actor from the vocabulary; narrow an `agent.decide` `allowedEvents` list; turn an open decision into a closed choice with `payloads`; tighten a prompt; add an `onError` path; lower a model ref to a cheaper one in the vocabulary.
- Use only names in the vocabulary. A named guard the host does not implement fails the `lower` gate.
- Keep the config `id`. Bump `version`.
- Keep the root `description` (the goal) unchanged. Changing the goal is the user's decision.

## 5. Gate

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

Run the candidate on the training scenarios, then on the held-out scenarios. Write every replay to the store under new thread ids that name the split and version (`train:v3:<scenario>:r1`, `heldout:v3:<scenario>:r1`), so the next round can list them by prefix.

- Run the current policy and the candidate on the same scenarios, the same world state, and the same model refs.
- Model calls are nondeterministic. Run each scenario k times (k ≥ 3 when calls are not cached) and compare means.
- Compute the objective, invariant violations, and cost per split, for both versions.

## 7. Promote or discard

State the tolerance before you replay. Promote only when every condition holds:

- invariant violations are 0 on both splits,
- the objective on the held-out split is better than the current policy's,
- no single scenario regresses beyond the tolerance (for example, a scenario that passed in all k runs now fails in any),
- cost stays within the stated budget, if there is one.

Otherwise discard the candidate and keep the current policy. Either way, append an entry to the `CHANGELOG.md` next to the policies: version, hypothesis, diff summary, gate results, before and after per split, and the decision. Record discarded candidates too; they stop the next round from retrying the same idea.

## 8. Stop and report

Stop when any of these holds:

- 3 rounds in a row without a promotion,
- the goal's success criteria are met on the held-out split,
- the remaining failures need an environment change (write a change request),
- the vocabulary lacks a capability the fix needs (ask for it; name the actor, request, or guard and its input and output).

Report to the user: rounds run, each candidate with its hypothesis and decision, the objective before and after on both splits, violations, cost, and any change requests.

## Worked example

`examples/self-improving-refunds` in the `statelyai/agent` repo runs this loop end to end:

- the refund desk is the environment: business rules as guards, and an `illegallyIssued` sentinel proven unreachable,
- `playbooks/*.json` are policy versions, with the vocabulary listed in `playbooks/README.md`,
- `improve.ts` is the loop: propose, gate, replay, promote,
- `benchmark.ts` compares a raw tool loop, the desk with a raw model deciding, and the desk with a playbook deciding.

Read the directory before you start. File contents change between releases.
