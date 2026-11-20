---
"@statelyai/agent": minor
---

`createApprovalBatchMachine` records each `APPROVE_ALWAYS` rule as `{ name, args }`, the approved call's tool name and arguments, one rule per distinct call. Before, a rule was `{ name }`, and a policy that allowed by name approved every argument the tool accepts. The docs now tell hosts to match both.
