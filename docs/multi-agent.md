# Multi-agent composition

Multi-agent systems are ordinary XState actor composition.

## Child machines

Register a child machine under `actors`, invoke it from a state, and handle its typed output with `onDone`. `runAgent` recursively binds Agent request actors in registered child machines.

## Long-lived actors

Invoke an agent machine at a parent state when it must survive transitions among nested substates. Send it events with XState's `sendTo`; receive outputs or emitted events through normal XState channels.

## Parallel teams

Use parallel states when the branch topology is known in the artifact. Use spawned actors when it is dynamic. Generic fan-out, child collection, actor identity, and persistence belong to XState rather than an Agent-specific abstraction.

## Collecting dynamic children

Spawned children are named at runtime, so the machine's event union cannot name their done events. Handle the canonical `xstate.done.actor` event and branch on `actorId`. `DoneActorEventOf<TLogic, TId?>` types that handler against the child's own output, which is XState's `DoneActorEvent` applied to the logic's `OutputFrom`.

```ts no-check
"xstate.done.actor": ({ context, event }) => {
  const { actorId, output } = event as DoneActorEventOf<typeof researchLogic>;
  if (!actorId.startsWith("research-")) return undefined;
  return { context: { findings: { ...context.findings, [actorId]: output.finding } } };
}
```

See [hierarchical teams](../examples/hierarchical-teams), [swarm handoff](../examples/swarm-handoff), [deep research](../examples/deep-research), and [game loop agent](../examples/game-loop-agent).
