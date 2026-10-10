---
"@statelyai/agent": minor
---

Reduce common-case agent ceremony:

- Payload-less events accept `{}` instead of an empty object schema.
- `@statelyai/agent/ai-sdk` exports an explicit AI SDK `runAgent` host using the machine's model registry.
- `createAgent` provides a one-call AI SDK machine plus `run(input)` entry point.
