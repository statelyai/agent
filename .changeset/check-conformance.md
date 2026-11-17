---
"@statelyai/agent": minor
---

Add `checkConformance` to `@statelyai/agent/testing`. It checks a recorded run of existing code against a model of that code. The model runs with each actor answered from the recording's observations, and the report names the first deviation (`unexpected-observation`, `missing-observation`, `input-mismatch`, `extra-observations`, `ignored-event`, or `unmapped-actor`) with the model's state, plus the actors the recording could not observe. Pass the reports' `trace` to `traceCoverage` for the states no recorded run reached.

- `output: { observes, matches }` checks the code's recorded return value against the model's output (`output-mismatch`).
- An `events` entry can be `{ event, matches }`, which compares the observation with the model's context before sending it, such as the draft a person approved.
- `recordAiSdk(ai, current)` records AI SDK code that builds its model inline or passes module-level tools to `generateText`: mock `"ai"` with it, and each `generateText` and `streamText` call uses the seam's model and records its tools.
- A model effect from `recorder.model` that failed and was retried with the same request has `retriedBy`, so a mapping can read one observation per call the code made.

The new [Verify in place](https://github.com/statelyai/agent/blob/next/docs/verify-in-place.md) guide and `examples/verify-in-place` walk through the track: a model of an unchanged refund loop, proofs, recorded runs checked against the model, coverage, and a seeded regression caught.
