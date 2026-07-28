---
"@statelyai/agent": minor
---

Model refs are open strings. A request's `model:` field accepts any string. When a `models` map is registered its keys still autocomplete, but any other string is legal (`AgentModelRef` widened to `(keyof TModels & string) | (string & {})`). The `models` map is optional; refs are opaque routing keys resolved by the host or the AI SDK adapter (its `models` map or `resolveModel`). Identity-map ceremony (`const models = { "x": "x" } as const`) is no longer needed for bare refs.
