---
"@statelyai/agent": patch
---

`explorePaths` and `canReach` accept readonly arrays in their options, so an `as const` options object type-checks: `outputs`, `errors`, `childEvents`, `hostEvents`, `usage`, and the lists a `payloads` callback returns.
