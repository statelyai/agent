# Burr Parity

This document tracks where `@statelyai/agent` covers the practical workflow patterns shown in the Apache Burr examples directory.

## Scope

The parity target is authoring semantics:

- explicit state and transitions
- independently testable model/action steps
- typed state, input, and output
- host-owned runtime execution
- persistence through XState snapshots
- streaming through host side channels

It is not a replacement for Burr's Python runtime, UI, tracker, persistence integrations, or Hamilton/Haystack integrations.

## External Reference

As of June 18, 2026, the upstream Burr examples directory includes examples such as `hello-world-counter`, `conversational-rag`, `llm-adventure-game`, `multi-agent-collaboration`, `multi-modal-chatbot`, `streaming-overview`, `tool-calling`, `tracing-and-spans`, `typed-state`, and `web-server`.

## Matrix

<!-- parity matrix derived from src/burr-equivalents/*.test.ts and docs/burr-parity.md scope -->

| Burr example pattern | Status | Agent equivalent |
| --- | --- | --- |
| Hello world counter / guarded loop | Covered | Explicit XState state, guarded loop, and final output in [`src/burr-equivalents/raw-xstate.test.ts`](/Users/davidkpiano/Code/agent/src/burr-equivalents/raw-xstate.test.ts) |
| Conversational RAG with memory in state | Covered | Retrieval as typed host actor, memory in machine context, answer as named task logic |
| Streaming overview router | Covered | Safety check, mode routing, streaming side channel, final text transition |
| Tool calling | Covered | Tool selection as structured text logic, local tool actors, final formatter text logic |
| Typed state / structured output | Covered | Schema-derived context/output plus named structured text logic |
| Multi-agent collaboration | Covered | Supervisor routing to typed worker actors |

## Why This Is Different

Burr action definitions are runtime-owned executable steps. `@statelyai/agent` keeps those steps as portable authoring contracts:

- `withTasks(...)` owns typed request construction.
- `setupAgent(...)` owns typed machine authoring.
- Hosts own model providers, streaming, persistence, tracing, and deployment.

That gives Burr-style individually testable actions without adopting a Burr-style runtime.

## Still Out Of Scope

- Burr UI/tracker parity as a packaged runtime feature
- Python integration packages
- Hamilton/Haystack adapter parity
- published persistence backends beyond XState snapshots and examples
