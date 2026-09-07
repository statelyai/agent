# Human in the loop

A human wait is an ordinary XState state with accepted events. A resting state with event handlers—or `meta.interaction`—settles `runAgent` as `idle`.

`isAgentIdle(snapshot)` exposes that default rule. Compose it with application-specific waits when needed:

```ts no-check
setupAgent({
  isIdle: (snapshot) =>
    isAgentIdle(snapshot) || snapshot.hasTag("waiting-for-webhook")
});
```

```ts no-check
awaitingApproval: {
  meta: {
    interaction: {
      label: "Approve {draft.subject}?",
      events: {
        APPROVE: { label: "Approve", style: "primary" },
        REJECT: { label: "Reject", style: "danger" }
      },
      textEvent: "REJECT"
    }
  },
  on: {
    APPROVE: { target: "sending" },
    REJECT: { target: "revising" }
  }
}
```

## Type the metadata

`interactionMetaSchema` is the schema for that `meta` shape, so a machine declares it once instead of restating the interaction fields:

```ts no-check
const schemas = createAgentSchemas({
  meta: interactionMetaSchema,
  context: contextSchema,
  events: { APPROVE: z.object({}), REJECT: z.object({ reason: z.string() }) }
});
```

It accepts an optional `interaction` with a `label` (a string with `{context.path}` interpolation, or a function of the context), an `events` map of choices, and a `textEvent`. `AgentInteractionMeta` is the matching TypeScript type.

## Render and validate

```ts no-check
const paused = await runAgent(machine, { input, executors });

if (paused.status === "idle") {
  const interaction = getInteraction(paused.snapshot);
  const event = eventFromInteraction(paused.snapshot, { type: "APPROVE" });

  await storage.put(id, paused.persist());
  return { interaction, event };
}
```

`getInteraction` interpolates labels, collapses whitespace, and filters choices and `textEvent` through XState's currently accepted events. `eventFromInteraction` preserves fixed fields declared in interaction metadata and validates the chosen payload against the machine's event schema.

Whitespace collapses because labels are usually authored as multi-line template literals and interpolated context can carry newlines of its own. Pass `{ preserveWhitespace: true }` when the label is deliberately multi-line, such as a rendered diff:

```ts no-check
const interaction = getInteraction(paused.snapshot, { preserveWhitespace: true });
```

Both functions are typed off the snapshot, so `eventFromInteraction` returns the machine's own event union. No cast is needed to send the result back:

```ts no-check
const event = eventFromInteraction(paused.snapshot, { type: "APPROVE" });
await runAgent(machine, { snapshot: paused.persist(), event, executors });
```

When the answer arrives over the wire instead of from your own code, skip the separate validation step: `resumeEvent` takes the raw body and `runAgent` validates it against the restored state, settling `{ status: "error", cause: "invalid-event" }` if it does not fit. See [Persistence](persistence.md#resume-with-an-untrusted-event).

## Drive several turns

```ts no-check
const result = await runAgentLoop(machine, {
  input,
  executors,
  persist: (snapshot) => storage.put(id, snapshot),
  onIdle: async ({ snapshot }) => {
    const interaction = getInteraction(snapshot);
    return promptUser(interaction);
  }
});
```

For HTTP or queue-based applications, persist `result.persist()` and resume in a later request with `runAgent({ snapshot, event })`. Storage remains framework-owned.
