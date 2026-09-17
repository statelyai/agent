---
"@statelyai/agent": minor
---

Text requests resolve to a `{ result, messages }` envelope, and the `agent.messages` event is removed.

- **`onDone` output is `{ result, messages }`.** Every text request (`requests`, `agent.generateText`, `agent.streamText`, `createTextLogic`) now resolves its invoke with `AgentTextResult<T>` (exported from `@statelyai/agent`): `output.result` is the validated result, typed from the request's output schema or `string`, and `output.messages` is the executor's framework-native response messages (`AgentMessage[]`, empty when the executor returned none). This is universal, not opt-in. Read `output.result` where you read `output` before, and append `output.messages` to `context.messages` in `onDone` to retain a transcript. Decisions and non-agent actors are unchanged.
- **JSON workflows.** Template expressions that read a request's output move from `{{ event.output.<field> }}` to `{{ event.output.result.<field> }}` (`{{ event.output.result }}` for a plain-text request). Non-request `actors` invokes still read `{{ event.output.<field> }}`.
- **`executeAgentRequest` returns `{ result, messages, raw }`** (was `{ output, raw }`). Pass `{ result, messages }` straight to `resolveAgentStep`.
- **Removed:** the reserved `agent.messages` event, `appendMessages`, the setup result's `appendMessages`, `AGENT_MESSAGES_EVENT_TYPE`, the `AgentMessagesEvent`/`AgentMessagesEventPayload` types, and the `unhandled-agent-messages` lint code. `messagesSchema`, `isAgentMessages`, and `getMessageText` remain.
