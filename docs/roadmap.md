# Roadmap

The design rule is XState++: add Agent logic without replacing framework behavior.

## In scope

- Stronger request/output/event inference
- Better interaction typing
- Stream adapters
- Eval and verification ergonomics
- More Agent-specific diagnostics
- Provider adapters as optional entry points

## Upstream or framework-owned

- Durable execution and effect recovery: XState / `xstate/durable`
- Generic fan-out and child-actor collection: XState
- State-machine lint: XState tooling
- Storage, queues, retries, and interruption policy: host frameworks
- Provider tool-loop semantics: provider SDK/executor

Stately Agent should forward these capabilities transparently rather than create parallel adapter layers.
