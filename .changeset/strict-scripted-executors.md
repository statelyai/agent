---
"@statelyai/agent": minor
---

`createScriptedExecutors` now distinguishes a script configuration fault from a model failure.

- An unknown script key and a queue that ran dry both throw the new exported `AgentScriptedExecutorError` (codes `scripted-executors-unknown-name` and `scripted-executors-exhausted`).
- The executor set is poisoned after the first fault: every later call rethrows it, so a run cannot continue against a half-broken script. Pass `strict: false` for the previous per-call behavior.
- `scripted.scriptError` holds the first fault, and `scripted.assertScriptOk()` rethrows it — one line after a run turns a fault that the machine's `onError` swallowed into a failing test.

Docs: `evals.md` now states the script-key rule once (request `name`, else invoke `id`, else state path — including the `name` field on an inline `agent.decide` input), plus the entry shapes and `repeat`, and `quickstart.md`, `verify.md`, `decisions.md`, and the readme point at it.
