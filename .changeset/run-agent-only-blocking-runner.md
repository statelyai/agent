---
"@statelyai/agent": minor
---

`runAgent` is the one blocking runner. `runToQuiescence` is no longer exported: replace `runToQuiescence(createAgentRuntime(machine, options), init)` with `runAgent(machine, { ...options, ...init })`, which runs the same loop. `createAgentRuntime` stays for hosts that drive the transition loop themselves. The docs, examples, and demo now use `runAgent`.
