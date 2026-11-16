---
"@statelyai/agent": patch
---

`loop-to-machine` skill and strangler-fig docs: extract a mid-method phase at step 0 and call it from the carved actor, instead of copying its lines. Copying stays only for code you can't edit, pinned with a hash test.
