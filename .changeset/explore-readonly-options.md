---
"@statelyai/agent": patch
---

`explorePaths` and `canReach` accept readonly arrays in their options, so an `as const` options object type-checks: `outputs`, `errors`, `childEvents`, `hostEvents`, `usage`, and the lists a `payloads` callback returns. The fields of `ExplorePathsOptions` are now readonly, so code that pushes onto a typed options object's arrays (`options.hostEvents!.push(...)`) builds the array first instead.
