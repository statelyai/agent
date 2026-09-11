---
"@statelyai/agent": patch
---

`examples/consensus-review`: `runConsensusReviewExample` takes `patch` instead of `input`. The host decides whether a patch is trusted; a caller-supplied patch is always external and always reaches human review.
