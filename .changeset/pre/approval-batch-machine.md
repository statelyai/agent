---
"@statelyai/agent": patch
---

Add `createApprovalBatchMachine` to `@statelyai/agent/machines`: one spawned child per proposed tool call runs a `policy` (`"allow"` | `"ask"` | `"deny"`), waits for `APPROVE` / `APPROVE_ALWAYS` / `REJECT` (routed by `callId`) when asked, and executes only approved calls through `execute`, either after every approval settles (`executeWhen: "allReady"`, default) or each as approved (`"eachReady"`). `CANCEL_ALL` ends the batch; output is per-call `{ id, status, result?, error?, reason? }` plus the `approveAlways` rules to persist.
