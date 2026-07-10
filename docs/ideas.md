# Ideas parked from the 1.x experimental sketch

`src/agent-experimental.ts` (deleted 2026-07-03) was a fully commented-out
1.x-era sketch. Nothing in it was salvageable as code, but two ideas in it are
worth keeping:

1. **Trajectory / experience memory.** Record `(prevState, event, nextState)`
   triples per run and use them as agent experience — for evals, replay
   scoring, or reward-weighted decision selection. The v2 step path already
   produces exactly this shape (the event-sourced step envelope, see
   docs/p0-design.md §4.3); an experiences store is a thin adapter over it.

2. **Graph-based planning to goal states.** Because the machine is a graph,
   "plan" = a path of legal events from the current state to a goal state.
   A planner can enumerate candidate paths (shortest-path over the machine
   graph) and let the model choose among *plans* rather than single events —
   a natural extension of the decision primitive from one event to an event
   sequence, with the same legality guarantees at every step.

Both are post-alpha roadmap, not commitments.
