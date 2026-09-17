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

`setupAgent` types every state's `meta` as `AgentInteractionMeta` by default, keyed by the machine's declared events. A choice or `textEvent` that names an event the machine never declared is a compile error:

```ts no-check
const agentSetup = setupAgent({
  context: contextSchema,
  events: { APPROVE: z.object({}), REJECT: z.object({ reason: z.string() }) },
});

agentSetup.createMachine({
  // ...
  states: {
    review: {
      meta: {
        interaction: {
          label: "Approve {subject}?",
          events: { APPROVE: "Approve", DECLINE: "Decline" }, // error: DECLINE is not an event
        },
      },
    },
  },
});
```

The descriptor is an optional `interaction` with a `label` (a string with `{context.path}` interpolation, or a function of the context), an `events` map of choices, and a `textEvent`. A machine that declares its own `meta` schema replaces the default; `interactionMetaSchema` is the runtime schema for the interaction shape when you build a schema pack by hand with `createAgentSchemas`.

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

When the answer arrives over the wire instead of from your own code, parse it at the boundary with `parseAgentEvent(machine, await request.json())` and pass the result as `event`. A bad payload throws, which is a 400; an event the paused state has no transition for is ignored and comes back as `result.ignored`. See [Persistence](persistence.md#resume-with-an-event-off-the-wire).

## Drive several turns

```ts no-check
let result = await runAgent(machine, { input, executors });

while (result.status === "idle") {
  const snapshot = result.persist();
  await storage.put(id, snapshot);
  const event = await promptUser(getInteraction(result.snapshot));
  result = await runAgent(machine, { snapshot, event, executors });
}
```

For HTTP or queue-based applications, persist `result.persist()` and resume in a later request with `runAgent({ snapshot, event })`. Storage remains framework-owned.
