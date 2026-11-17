---
"@statelyai/agent": minor
---

Move the trace analytics from `@statelyai/agent/testing` to a new `@statelyai/agent/evals` subpath: `foldTraces`, `traceCoverage`, `firstDivergence`, `getDecisionRequests`, `repeatRuns`, `summarizeRepeats`, `judgeAgreement`, `proposeApprovalRules`, and `proposeCaps`, with their types. `@statelyai/agent/testing` keeps lint, simulation, exploration, trajectories, seams, crash recovery, and parity. Change the import path; the functions are unchanged.
