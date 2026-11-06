---
"@statelyai/agent": patch
---

Skills and docs from a timed brownfield self-improvement trial: ported runners take a run-options argument passed through to `runAgent` (the strangler-fig example's step 1 runner now does), prompt text moves into a versioned request config at carve time, thread ids for decider-less machines include the request version, and `improve-machine` covers prompt text in code you may not edit and values lost between states that `foldTraces` cannot show.
