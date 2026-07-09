---
"@statelyai/agent": minor
---

New `agent.plan` builtin: a multi-event decision. Where `agent.decide` picks exactly one legal event, `agent.plan` applies an ordered sequence of them: each step re-reads the live snapshot, asks the `decide` executor for one legal event (same validation and `rejected-by-guard` retry loop as a decision), sends it to the machine, and repeats until a `stopOn` sentinel is chosen, `maxSteps` (default 8) is reached, no legal candidate remains, or an applied event exits the invoking state. The applied trail is appended to the prompt each step. Partial application, no rollback. Requires `runAgent` (snapshot-aware host); no new executor slot. See docs/decisions.md and examples/todo-nl.
