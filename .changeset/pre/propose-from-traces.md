---
"@statelyai/agent": patch
---

Add `proposeApprovalRules` and `proposeCaps` to `@statelyai/agent/testing`: from many runs' traces, propose an `allow`/`deny` rule per approval key (allow only when never rejected and no violation, with `support` as the run count) and a value per cap (`p95` of passing runs plus one, never below `current` while runs hit the cap). Proposals are for a person; nothing promotes them.
