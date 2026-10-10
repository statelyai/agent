---
"@statelyai/agent": minor
---

New exports for the interaction, decision, and verification surfaces:

- `interactionMetaSchema` (plus the `AgentInteractionMeta`, `AgentInteractionDescriptor`, and `AgentInteractionEventMeta` types) validates the `meta.interaction` shape `getInteraction` reads, so machines stop restating it.
- `getInteraction(snapshot, { preserveWhitespace })` keeps deliberately multi-line labels intact; the default still collapses whitespace.
- `getInteraction` and `eventFromInteraction` are now generic over the snapshot, so the returned choices and event are typed as the machine's own event union instead of `EventObject`.
- `createDecisionRequest({ model, events, ... })` builds an `AgentDecisionRequest` for `resolveDecision`, filling in `kind`, `id`, `attempts`, and each candidate's `toolName`.
- `getStatePath(snapshot)` renders nested and parallel state values as one deterministic string (`review.editing`, `p:{left.x,right.y}`).
- `DoneActorEventOf<TLogic, TId?>` types a wildcard `xstate.done.actor` handler for dynamically spawned children.
- `lintAgentMachine` adds the `invoke-without-on-error` warning for an invoke with no `onError` and no ancestor error handling.
- `createScriptedExecutors` now fails with a clear error naming the known script keys when a name-keyed `text`/`decisions` script has no route for a request name.
- `isAgentMessages(value)` is the type guard behind `messagesSchema`, for zod context schemas: `messages: z.custom<AgentMessage[]>(isAgentMessages)`. A zod object cannot nest a Standard Schema directly; the `messagesSchema` doc comment now says so.
