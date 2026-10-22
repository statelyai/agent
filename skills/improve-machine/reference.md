# Improve-machine templates

Templates for the `improve-machine` skill: a round checklist, the hypothesis, the proposer prompt, the changelog entry, and the environment change request.

## Round checklist

```
[ ] Goal confirmed (root description, measurable success criteria)
[ ] Objective confirmed by the user (primary metric, violations = 0, cost term)
[ ] Train / held-out split fixed; tolerance stated
[ ] Vocabulary listed (actors, requests, guards, actions, events, models)
[ ] Baseline: objective, violations, cost per split for the current version
[ ] Failures clustered (train only); one cause picked
[ ] Hypothesis written
[ ] Candidate: smallest diff, id kept, version bumped, description unchanged
[ ] Gates passed: TS (env unchanged, tsc, lint, paths, overfit, evals) or JSON (verifyAgentConfig) (repairs used: _/3)
[ ] Replayed train, then held-out, k runs each, new thread ids
[ ] Promotion rule applied; CHANGELOG entry written
[ ] Recommended candidate opened as one pull request with its scorecard; not merged
[ ] Stop condition checked
```

## Hypothesis

```
Cause: <one sentence, the mechanism, not the symptom>
Evidence: <thread ids and what each shows>
Change: <the one diff, in words>
Expected effect: <metric> moves from <x> to about <y>; nothing else changes
Risk: <scenarios that could regress, and why>
```

## Proposer prompt

Use this when a model proposes the candidate. Fill every slot from real data.

```
You improve a policy machine. You may change only the policy config below.

{describeMachine(environment)}

Current policy (version {n}):
{the policy file's source, or JSON.stringify(policyConfig, null, 2)}

Vocabulary (use no other names):
- actors: {actors}
- requests: {requests}
- named guards: {guards}
- named actions: {actions}
- decision events: {events}
- model refs: {models}

Objective on the training scenarios: {objective summary}
Diagnosed cause: {hypothesis.cause}
Evidence: {failing rows: scenario, expected, reached state, rejections, tokens}

Return the complete policy: the TypeScript file, or one AgentWorkflowConfig as
JSON. Make the smallest change that addresses the diagnosed cause. Keep "id" and
"description". Set "version" to {n + 1}. Never match on a scenario's data.
```

On a failed gate, append:

```
Your previous config was rejected.
Gate '{gate.name}' failed:
{gate.detail}
Return a corrected config.
```

## Changelog entry

```md
## v{n} — {recommended | discarded}

- Hypothesis: {cause} → {change}
- Diff: {states or transitions touched}
- Gates: {TS: environment ✓ tsc ✓ lint ✓ paths ✓ overfit ✓ evals ✓ | JSON: validate ✓ vocabulary ✓ lower ✓ lint ✓ explore ✓} (repairs: {r})
- Train: objective {a} → {b}, violations {v}, cost {c0} → {c1}
- Held-out: objective {a} → {b}, violations {v}, cost {c0} → {c1}
- Regressions: {none | scenario ids}
- Decision: {why}
```

## Environment change request

Write this instead of editing the environment.

```md
# Environment change request: {short title}

- Goal criterion blocked: {the success criterion no policy can meet}
- Evidence: {thread ids; the state and guard that block it}
- Policies tried: {versions and why each could not get there}
- Proposed change: {the state, guard, or event to add or change, in words}
- Invariants affected: {which, and the canReach check to rerun}
- Owner: a person reviews and merges this; the improver does not.
```
