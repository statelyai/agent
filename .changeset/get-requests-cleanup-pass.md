---
"@statelyai/agent": patch
---

Hardening and clean-up for the (unreleased) `getRequests` state-interpretation pass:

- A plain invoke-driven resume no longer drops a `messages` log carried in on the snapshot: any non-empty log is re-stamped on settle, matching `agentMeta`.
- A decide call that resolves after the run has settled no longer appends its `[chose: ...]` marker (no stray post-settle `onMessage`).
- Interpret `request.end` traces now lift `reasoning` off the raw executor result, matching the invoke-driven text path.
- The synthetic trace src is the exported `INTERPRET_SOURCE` constant (`"agent.interpret"`) beside the other `agent.*` source names.
- The `getRequests` hook's second parameter is named `agentContext` to disambiguate from machine context; docs now cover `getRequests`/`messages`/`onMessage` (xstate-as-agent-workflow, examples index).
