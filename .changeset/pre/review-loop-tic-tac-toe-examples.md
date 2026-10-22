---
"@statelyai/agent": patch
---

**Two more environment and policy examples.**

- `examples/code-review-loop` keeps the review loop fixed: generate, then a self-check and an independent review in parallel, then checks, then ship, retry or ask a person. `canReach` proves it never ships without passing checks and approval. A JSON triage policy decides between retrying and escalating, and it is improved from event-log traces against hidden tests. It runs on Claude Code in headless mode.
- `examples/tic-tac-toe` is a plain XState game that knows nothing about AI, with the agent playing O at its boundary through `decideNext`. A JSON policy over low-level board features climbs from "first empty cell" to a policy that `canReach` proves never loses to any opponent.
