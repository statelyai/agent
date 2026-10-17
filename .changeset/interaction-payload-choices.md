---
"@statelyai/agent": minor
---

Interactions can offer one button per payload, not only one per event type.

- `meta.interaction.choices`: a list of `{ label, event, style? }`, each carrying the full event it sends ("Seat 2" for `ACCUSE { seat: 2 }`).
- `meta.interaction.choicesFrom`: a context path holding an array of the same shape, for choices computed at runtime.
- `getInteraction(snapshot).choices` resolves both, interpolates `{context.path}` in labels, and keeps only the events the schema and `snapshot.can` accept. The `events` list is unchanged.
- `eventFromInteraction(snapshot, { choice })` returns a choice's event by index or label.
- `textEvent` also takes `{ type, field }` to name the field free text fills; `getInteraction` reports it as `textField`. The bare form still fills `text`.
- `getInteraction` and `eventFromInteraction` fall back to a plain XState machine's `schemas.events` when no `setupAgent` schemas are registered.
- New types: `AgentInteractionChoice`, `AgentInteractionChoiceMeta`.
