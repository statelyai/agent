---
"@statelyai/agent": minor
---

**`compareRuns` checks a port against the code it replaces.** From `@statelyai/agent/testing`: `compareRuns({ scenarios, baseline, candidate })` runs each scenario through both and labels it `same`, `intended` (the candidate broke no rule where the baseline broke one, or only the candidate reached the expected outcome), or `regression`. It compares outcomes and effects, not tool-call order.
