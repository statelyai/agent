---
"@statelyai/agent": minor
---

The inline text builtins `agent.generateText` and `agent.streamText` are removed; `agent.decide` is now the only builtin actor source, and the whole `agent.` prefix stays reserved. To migrate, declare the call as a `setupAgent({ requests })` entry (with `schemas`, `model`, and `prompt` or `messages`; set `mode: "stream"` for streaming) and invoke it by its key, or register a `createTextLogic` actor under `actors`. The request's output schema now types and validates `output.result`, which the inline builtins did not do under the runtime.
