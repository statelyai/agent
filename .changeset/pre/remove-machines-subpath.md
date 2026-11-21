---
"@statelyai/agent": major
---

Remove the `@statelyai/agent/machines` subpath and `createApprovalBatchMachine`. Approval is domain logic, not a library feature: a state that waits for a person's event, plus a rule check in context. The new `examples/approve-tool-calls` example shows that machine with approve, deny, and approve-always, calls run in proposal order, rules that match the same tool and arguments only, and a `canReach` proof that no call runs without a rule or a person's approval. Copy it and change the ordering or rule matching your domain needs. See [Approval gate](https://github.com/statelyai/agent/blob/next/docs/tools.md#approval-gate).
