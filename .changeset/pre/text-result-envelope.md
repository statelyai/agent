---
"@statelyai/agent": minor
---

Text requests resolve to `{ result, messages }` on both sides of the executor contract, and the `agent.messages` event is removed.

- **`onDone` output is `{ result, messages }`.** Every text request (`requests`, `agent.generateText`, `agent.streamText`, `createTextLogic`) now resolves its invoke with `AgentTextResult<T>` (exported from `@statelyai/agent`): `output.result` is the validated result, typed from the request's output schema or `string`, and `output.messages` is the executor's framework-native response messages (`AgentMessage[]`, empty when the executor returned none). This is universal, not opt-in. Read `output.result` where you read `output` before, and append `output.messages` to `context.messages` in `onDone` to retain a transcript. Decisions and non-agent actors are unchanged.
- **JSON workflows.** Template expressions that read a request's output move from `{{ event.output.<field> }}` to `{{ event.output.result.<field> }}` (`{{ event.output.result }}` for a plain-text request). Non-request `actors` invokes still read `{{ event.output.<field> }}`.
- **Executors return the same shape.** `generateText`/`streamText` executors return `{ result, messages?, usage?, ... }` instead of `{ output, ... }`: `result` is the value, `messages` the provider's response messages. `AgentRequestExecutorResult`, `createScriptedExecutors` entries (`{ result, usage }` to report usage), `bindRequestExecutor`, `TextLogic.withExecutor`, and `onResult(request, { result, raw })` all follow. The `request.end` trace event is unchanged.
- **`executeAgentRequest` returns `{ result, messages, raw }`** (was `{ output, raw }`). Pass `{ result, messages }` straight to `resolveAgentStep`.
- **Provider schema helpers renamed.** `buildEnvelopeSchema` is `providerOutputSchema`, `parseStructuredEnvelope` is `parseProviderOutput`, and `StructuredOutputEnvelope` is `ProviderStructuredOutput`. They build and parse the `{ result, reasoning? }` object a provider is asked for; the parsed value is already an executor result.
- **Removed:** the reserved `agent.messages` event, `appendMessages`, the setup result's `appendMessages`, `AGENT_MESSAGES_EVENT_TYPE`, the `AgentMessagesEvent`/`AgentMessagesEventPayload` types, and the `unhandled-agent-messages` lint code. `messagesSchema`, `isAgentMessages`, and `getMessageText` remain.
