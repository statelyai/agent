# Human in the loop

A human wait is an ordinary XState state with accepted events. Once no child,
request, or in-process timer remains active, `runAgent` settles as
`idle`. Use `isAgentIdle(snapshot)` afterward to distinguish an intentional
human wait from a stuck machine.

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

The descriptor is an optional `interaction` with a `label` (a string with `{context.path}` interpolation, or a function of the context), an `events` map of choices, payload `choices` (an array, or a context path), and a `textEvent`. A machine that declares its own `meta` schema replaces the default; `interactionMetaSchema` is the runtime schema for the interaction shape, for a machine that passes `meta` to `setupAgent` itself.

## Payload choices

An `events` entry is one button per event type. When one event type needs several buttons, one per payload, declare `choices` instead. Each choice is a label and the full event it sends:

```ts no-check
voting: {
  meta: {
    interaction: {
      label: "Who is the chameleon?",
      choices: [
        { label: "Seat 1", event: { type: "ACCUSE", seat: 1 } },
        { label: "Seat 2", event: { type: "ACCUSE", seat: 2 } },
        { label: "Pass", event: { type: "PASS" }, style: "danger" }
      ]
    }
  },
  on: { ACCUSE: { target: "revealing" }, PASS: { target: "revealing" } }
}
```

When the choices depend on context, keep them in a context array of the same shape and set `choices` to its path. The refund desk computes this turn's proposals on entry to `deciding`:

```ts no-check
deciding: {
  entry: ({ context }) => ({ context: { choices: deskChoices(context) } }),
  meta: {
    interaction: {
      label: "Turn {turn}: {notice} Choose the next step.",
      choices: "choices" // [{ label: "Refund $240", event: { type: "ISSUE_REFUND", amount: 240 } }, ...]
    }
  }
}
```

`getInteraction(snapshot).choices` lists the declared choices, inline or read from the context path:

- Labels interpolate `{context.path}` like the interaction label.
- Each event is checked against the machine's event schema and `snapshot.can(event)`. Only the choices the machine takes right now are listed.
- `choices` is present only when the state declares `choices`. The `events` list is unchanged.

Convert a pressed button back with its index in `choices`, or its label. A label that several listed choices share throws; pass the index instead:

```ts no-check
const first = eventFromInteraction(paused.snapshot, { choice: 0 });
const refund = eventFromInteraction(paused.snapshot, { choice: "Refund $240" });
// { type: "ISSUE_REFUND", amount: 240 }
```

## Free-text field

`textEvent: "REJECT"` puts the text in a `text` field. Name another field with `{ type, field }`:

```ts no-check
asking: {
  meta: {
    interaction: {
      label: "Please confirm your identity.",
      textEvent: { type: "IDENTITY_CLAIM", field: "claim" }
    }
  },
  on: { IDENTITY_CLAIM: { target: "verifying" } }
}
```

`getInteraction` reports `textEvent: "IDENTITY_CLAIM"` and `textField: "claim"`, and `eventFromInteraction(snapshot, { text })` returns `{ type: "IDENTITY_CLAIM", claim: text }`. `textField` is absent when the field is `text`.

## Render and validate

```ts no-check
const paused = await runAgent(machine, { executors, input });

if (paused.status === "idle") {
  const interaction = getInteraction(paused.snapshot);
  const event = eventFromInteraction(paused.snapshot, { type: "APPROVE" });

  await storage.put(id, paused.persist());
  return { interaction, event };
}
```

`getInteraction` interpolates labels, collapses whitespace, and filters choices and `textEvent` through XState's currently accepted events. `eventFromInteraction` preserves fixed fields declared in interaction metadata and validates the chosen payload against the machine's event schema.

Both read event schemas from `setupAgent`, or from a plain XState machine's own `setup({ schemas: { events } })`.

Whitespace collapses because labels are usually authored as multi-line template literals and interpolated context can carry newlines of its own. Pass `{ preserveWhitespace: true }` when the label is deliberately multi-line, such as a rendered diff:

```ts no-check
const interaction = getInteraction(paused.snapshot, { preserveWhitespace: true });
```

Both functions are typed off the snapshot, so `eventFromInteraction` returns the machine's own event union. No cast is needed to send the result back:

```ts no-check
const event = eventFromInteraction(paused.snapshot, { type: "APPROVE" });
await runAgent(machine, { executors, snapshot: paused.persist(), event });
```

When the answer arrives over the wire instead of from your own code, parse it at the boundary with `parseAgentEvent(machine, await request.json())` and pass the result as `event`. A bad payload throws, which is a 400; an event the paused state has no transition for is ignored and comes back as `result.ignored`. See [Persistence](persistence.md#resume-with-an-event-off-the-wire).

## Drive several turns

```ts no-check
let result = await runAgent(machine, { executors, input });

while (result.status === "idle") {
  const snapshot = result.persist();
  await storage.put(id, snapshot);
  const event = await promptUser(getInteraction(result.snapshot));
  result = await runAgent(machine, { executors, snapshot, event });
}
```

For HTTP or queue-based applications, persist `result.persist()` and resume in
a later request with a fresh runtime and `{ snapshot, event }`. Storage remains
framework-owned.
