---
"@statelyai/agent": patch
---

`agent.act` offers as `send_event_<TYPE>` tools every event the invoking state can accept while it stays active: handlers on the invoking state, its ancestors, and all of its descendants. Before, it offered only the events the state accepted when the invoke started, so an event a later sub-state accepts was never offered. A call the current snapshot cannot take is refused as before. Run usage now counts every provider request an act loop made and the tokens of every response it received, also when a state exit ends the loop: the run waits for the aborted executor to settle. The AI SDK, OpenAI, and TanStack AI adapters report the usage of the responses a failed or aborted tool loop received on the thrown error, and the runtime records it.
