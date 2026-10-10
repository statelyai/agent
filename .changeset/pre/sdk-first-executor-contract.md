---
"@statelyai/agent": minor
---

Tighten the executor contract around SDK hosts.

- **Removed `agent.userInput`**, the `userInput` run option, `pendingUserInputs`, `PendingUserInput`, `AgentUserInput`, `AgentUserInputExecutor`, the scripted `userInput` channel, and the `userInput` shorthand in `simulateAgent`/`explorePaths` scripts (use `invokes` keyed by src). A human's turn is an idle state with accepted events; see the human-in-the-loop docs.
- **Executors return `{ result }` only.** The raw Vercel AI SDK result shapes (`{ text }`, `{ textStream }`) are no longer sniffed, `AiSdkShapedTextResult`/`AiSdkShapedStreamResult` are gone, and `AgentExecutorTextRequest` keeps precise `tools`/`messages` types instead of widening them to `any`. Use `createAiSdkExecutors` or a plain function.
- **Removed `defineModels`.** Pass the plain `models` map to `setupAgent({ models })` and to `createAiSdkExecutors({ models })`; the machine's model refs are typed from its keys either way. No executors are attached implicitly; pass `executors` explicitly to `runAgent`. (A library that exports its map from a package with declaration emit annotates it as `AiSdkModelMap<'quick' | 'deep'>`, as with any exported AI SDK value.)
- **Removed the `eventToolName` resolver** (`AgentEventToolNameResolver`). Event tool names are always `send_event_<TYPE>`.
- **`parseModelRef` moved** to `@statelyai/agent/ai-sdk`.
