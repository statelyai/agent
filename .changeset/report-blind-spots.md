---
"@statelyai/agent": patch
---

Report what coverage and proofs did not try. `traceCoverage` lists visited handlers with a function transition in `opaqueHandlers`: the trace shows the handler ran, not which branches inside the function it took, so `ratio.handlers` does not cover those branches. `explorePaths` reports and `canReach` results carry `assumedOutputs`, the `outputs` entry of every src the search settled from, so a reader can see that `complete` covers those outputs only.
