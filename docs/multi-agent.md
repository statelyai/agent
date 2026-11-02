# Multi-agent composition

Multi-agent systems are ordinary XState actor composition.

## Child machines

Register a child machine under `actors`, invoke it from a state, and handle its typed output with `onDone`. `runToQuiescence` recursively binds Agent request actors in registered child machines.

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

## Barriers

Spawned children that must all reach a checkpoint before any proceeds use two events: a child→parent status event and a parent→child release event.

- **Child.** On entry to its checkpoint state, it sends the parent a status event, then waits for `RELEASE`.
- **Parent.** It counts status events. When every child has reported (or finished), it sends each held child `RELEASE`.

```ts no-check
// Child: report, then wait.
ready: {
  entry: ({ context, parent }, enq) => {
    if (parent) enq.sendTo(parent, { type: "CHILD_READY", id: context.id });
  },
  on: { RELEASE: { target: "working" } },
},

// Parent: hold until everyone reported, then release them all.
collecting: {
  on: {
    CHILD_READY: ({ context, event, children }, enq) => {
      const ready = [...context.ready, event.id];
      if (ready.length + context.finished.length < context.total) {
        return { context: { ready } };
      }
      for (const id of ready) enq.sendTo(children[`worker:${id}`], { type: "RELEASE" });
      return { context: { ready: [] } };
    },
  },
},
```

- **Release per child instead.** Send `RELEASE` in the `CHILD_READY` handler itself; the barrier disappears and each child proceeds on its own.
- **Safety lives in the child.** The child takes `RELEASE` only in its checkpoint state, so a stray or forged release cannot skip a step. Check it with `canReach` on the child machine.
- **Preset.** `createApprovalBatchMachine` is this pattern for tool calls: one child per call, the checkpoint is approval, and `executeWhen` picks barrier or per-child release. See [Preset machines](machines-presets.md#createapprovalbatchmachine).

## Events from one model turn

[`agent.act`](act.md) sends several events from one tool loop, each applied as it arrives. Use it when every event the model calls is safe to apply; use the approval batch when each needs a verdict first.

See [hierarchical teams](https://github.com/statelyai/agent/blob/next/examples/hierarchical-teams), [swarm handoff](https://github.com/statelyai/agent/blob/next/examples/swarm-handoff), [deep research](https://github.com/statelyai/agent/blob/next/examples/deep-research), and [game loop agent](https://github.com/statelyai/agent/blob/next/examples/game-loop-agent).
