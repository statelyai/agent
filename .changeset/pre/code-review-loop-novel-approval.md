---
"@statelyai/agent": patch
---

`examples/code-review-loop`: a review that approves a patch but still flags a `novel` issue now goes to a person instead of shipping. `checkingShip` enforces the same rule, so the `canReach` proof covers it. `docs/from-a-loop.md` gains Part 2, which ports the software-factory loop in `examples/code-review-loop/before.ts` to the machine and improves its triage from traces.
