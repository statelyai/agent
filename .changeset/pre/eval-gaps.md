---
"@statelyai/agent": minor
---

**Four eval helpers in `@statelyai/agent/testing`.**

- `traceCoverage(machine, traces, { reachable? })` reports which states and handlers no trace exercised. Coverage is per handler: a state and an event it handles, with the targets it declares and the ones runs reached. `always` handlers are listed as unobservable, because traces record one step per macrostep.
- `repeatRuns({ scenarios, k, run, passed })` runs each scenario `k` times and reports passes, pass@k, pass^k, distinct paths, and the state where the runs diverged. `report.passHat(j)` estimates the suite's pass^j. `summarizeRepeats` builds the same report from runs collected elsewhere.
- `judgeAgreement(rows, { positive?, groupBy? })` compares a judge's labels with confirmed human labels: accuracy, per-label recall, the confusion matrix, disagreements, the true positive and true negative rates, and a correction for the judge's bias.
- `firstDivergence(actual, reference)` finds the first step where a run departs from a reference trace or an expected trajectory, and names the state it was in.
- `foldTraces` takes a `blame` option and adds a `blamed` column: failed runs counted once, against the state their failure started in. Rows now always include `blamed`, which is 0 without `blame`.
