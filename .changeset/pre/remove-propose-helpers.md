---
"@statelyai/agent": minor
---

Remove `proposeApprovalRules` and `proposeCaps` from `@statelyai/agent/evals`, with their types. Each generated one kind of change (skip a person's approval, retune a cap), and neither checked a proposal against the machine's proved rules: in trials, `proposeApprovalRules` proposed an auto-approval that broke one. The evals tools now only diagnose. Write the change yourself or with a model, and gate it with `canReach` and `compareRuns`, as `docs/evals.md` "Changes from traces" describes.
