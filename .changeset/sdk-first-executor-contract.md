---
"@statelyai/agent": minor
---

Tighten the executor contract around SDK hosts.

- **Removed `agent.userInput`**, the `userInput` run option, `pendingUserInputs`, `PendingUserInput`, `AgentUserInput`, `AgentUserInputExecutor`, the scripted `userInput` channel, and the `userInput` shorthand in `simulateAgent`/`explorePaths` scripts (use `invokes` keyed by src). A human's turn is an idle state with accepted events; see the human-in-the-loop docs.
- **Executors return `{ output }` only.** The raw Vercel AI SDK result shapes (`{ text }`, `{ textStream }`) are no longer sniffed, `AiSdkShapedTextResult`/`AiSdkShapedStreamResult` are gone, and `AgentExecutorTextRequest` keeps precise `tools`/`messages` types instead of widening them to `any`. Use `createAiSdkExecutors` or a plain function.
- **`defineModels` is a pure typing helper.** It no longer attaches hidden default executors; pass `executors` explicitly to `runAgent`.
- **Removed the `eventToolName` resolver** (`AgentEventToolNameResolver`). Event tool names are always `send_event_<TYPE>`.
- **`parseModelRef` moved** to `@statelyai/agent/ai-sdk`.
