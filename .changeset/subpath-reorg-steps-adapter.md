---
"@statelyai/agent": minor
---

API surface cleanup. Breaking (alpha).

**Removed outright**

- `EVENT_TOOL_PREFIX` (now internal; it just prefixes generated event tool names as `send_event_`).

**Other changes**

- New root type export `PlanLogic` — fixes TS4023 "cannot be named" when re-exporting a machine that uses `agent.plan`.
- `AgentRequestExecutors` slots are now all optional (`generateText?`, `streamText?`, `decide?`); a missing slot is still a clear bind-time error when the machine needs it. Adapter result sets (`AiSdkExecutors`) still require all three.
- `SimulationScript.userInput` renamed to `invokes` (the by-src scripted-invoke channel for `simulateAgent`; unrelated to the `agent.userInput` actor).
