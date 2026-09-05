# Multi-agent composition

Multi-agent systems are ordinary XState actor composition.

## Child machines

Register a child machine under `actors`, invoke it from a state, and handle its typed output with `onDone`. `runAgent` recursively binds Agent request actors in registered child machines.

## Long-lived actors

Invoke an agent machine at a parent state when it must survive transitions among nested substates. Send it events with XState's `sendTo`; receive outputs or emitted events through normal XState channels.

## Parallel teams

Use parallel states when the branch topology is known in the artifact. Use spawned actors when it is dynamic. Generic fan-out, child collection, actor identity, and persistence belong to XState rather than an Agent-specific abstraction.

See [hierarchical teams](../examples/hierarchical-teams), [swarm handoff](../examples/swarm-handoff), [deep research](../examples/deep-research), and [game loop agent](../examples/game-loop-agent).
