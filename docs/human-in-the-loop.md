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
