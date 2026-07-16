---
"@statelyai/agent": minor
---

New `agent.plan` builtin: a multi-event decision. Where `agent.decide` picks exactly one legal event, `agent.plan` applies an ordered sequence of them: each step re-reads the live snapshot, asks the `decide` executor for one legal event (same validation and `rejected-by-guard` retry loop as a decision), sends it to the machine, and repeats.

Every step is offered a built-in done move: a reserved `agent.plan.done` candidate (`PLAN_DONE_EVENT_TYPE`). Choosing it ends the plan with `stopped: 'done'` and is never sent to the machine, so machines need no no-op sentinel event of their own. The plan also ends at `maxSteps` (default 8), when no legal candidate remains, or when an applied event exits the invoking state. `stopOn` remains for the rarer "send this real event AND stop" case (`stopped: 'stop-event'`).

The applied trail is appended to the prompt each step. Partial application, no rollback. `onDone` output is `{ steps, stopped }`. Requires `runAgent` (snapshot-aware host); no new executor slot. See docs/decisions.md and examples/todo-nl.
