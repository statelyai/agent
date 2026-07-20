# Product

## Register

product

## Users

AI developers evaluating how to build reliable agents, especially developers unfamiliar with XState or statecharts. They understand chat applications, model calls, and tools, but may not yet see agent workflows as explicit executable state machines.

## Product Purpose

Create an immersive devtool that makes the benefits of state-machine agents immediately tangible. A runnable, chat-like application and a live statechart inspector show the same execution from two perspectives, so developers see how explicit states, legal events, guards, invoked work, retries, and human pauses constrain and explain model behavior.

Success is the realization that the model proposes events while the state machine owns control flow, making agents live-inspectable, predictable, resumable, and testable.

## Brand Personality

Technical, vivid, trustworthy. The interface should feel like a serious developer instrument with an unusually clear live demonstration, not marketing theater.

## Anti-references

- Generic ChatGPT clones where every system action appears as another chat bubble.
- Node-editor tutorials that ask users to learn diagramming before experiencing the benefit.
- Dashboard-heavy observability products that bury the execution story under metrics and panels.
- Cinematic demos whose motion obscures cause and effect.

## Design Principles

- Show one execution from three synchronized perspectives: example, application, and machine.
- Make cause and effect unmistakable: each application event visibly activates the corresponding statechart transition.
- Introduce statechart concepts through observed behavior, not prerequisite explanation.
- Keep the machine authoritative: the model proposes; guards and legal events decide.
- Default to a deterministic, replayable experience so the aha moment never depends on model latency or output variance.

## Accessibility & Inclusion

Meet WCAG 2.2 AA. Support complete keyboard operation, visible focus, non-color-only state indicators, screen-reader announcements for execution changes, and a reduced-motion mode that preserves causal sequencing without animated travel.
