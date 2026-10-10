---
"@statelyai/agent": patch
---

**Works with XState 6.0.0-alpha.47 and later.** Two type regressions surfaced by alpha.47, both in this package's own plumbing rather than in a machine you write.

- `setupAgent({ guards, delays })` typed both slots through XState's fully generic `AnySetupConfig`, so a source saw `MachineContext` instead of the agent's own context. alpha.47 tightened those source types, which rejected the parameter annotations that were previously the only way to type them. Both slots are now typed from the agent's own context and event schemas, so an inline source is contextually typed and no annotation is needed.
- alpha.47 resolves a machine's input type to `<input> | undefined`. `AgentInputFrom` matched that union against the input-schema brand, `undefined` never matched an object type, and the brand was dropped — so a field declared with a schema default read as required at the `runAgent({ input })` call site. The brand is now unwrapped through the optional union.

The `xstate` peer range is unchanged (`>=6.0.0-alpha.46 <6.0.0`); both fixes hold on alpha.46 as well.
