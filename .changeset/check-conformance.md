---
"@statelyai/agent": minor
---

Add `checkConformance` to `@statelyai/agent/testing`. It checks a recorded run of existing code against a model of that code. The model runs with each actor answered from the recording's observations, and the report names the first deviation (`unexpected-observation`, `missing-observation`, `input-mismatch`, `extra-observations`, or `unmapped-actor`) with the model's state, plus the actors the recording could not observe. Pass the reports' `trace` to `traceCoverage` for the states no recorded run reached.
