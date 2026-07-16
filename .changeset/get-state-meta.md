---
"@statelyai/agent": patch
---

Add `getStateMeta(snapshot)`: returns the merged, typed `meta` of a snapshot's active state(s).

It replaces the untyped `Object.values(snapshot.getMeta())[0]` cast used to read a state's interaction protocol in human-in-the-loop hosts. The return type is recovered from the snapshot's own `getMeta()` type, so a schema-typed machine (`setupAgent({ meta })`) yields the meta schema's output type; pass an explicit type param for untyped snapshots. Meta from every active state is shallow-merged (later/deeper wins for nested and parallel machines), returning `{}` when no active state declares meta.
