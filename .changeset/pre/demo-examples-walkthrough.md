---
"@statelyai/agent": patch
"@statelyai/agent-demo": patch
---

`examples/triage`: the classifier's `confidence` is required. Its default made OpenAI strict structured output reject every classification, so every live run escalated as unclassified. `examples/consensus-review` starters carry `source`; `examples/snapshot-migration`, `examples/plain-xstate`, and `examples/portable-xstate-loop` describe their idle states.

Demo: resolves the library from `src/` (a stale `dist/` no longer runs old code under new examples), keeps the viz embed mounted across example switches and drives it through `@statelyai/sdk`'s `createStatelyEmbed`, sends JSON-authored machines to Viz as config, runs text starters on machines without a prompt input, and shows chat-loop replies kept only in message history.
