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

<!-- parity matrix derived from examples/burr-*/metadata.json and docs/burr-parity.md scope -->

| Burr example pattern | Status | Agent equivalent |
| --- | --- | --- |
| Hello world counter / guarded loop | Covered | Explicit XState state, guarded loop, and final output in [`examples/burr-counter/index.test.ts`](/Users/davidkpiano/Code/agent/examples/burr-counter/index.test.ts) |
| Conversational RAG with memory in state | Covered | Retrieval as typed host actor, memory in machine context, answer as named request logic in [`examples/burr-conversational-rag/index.test.ts`](/Users/davidkpiano/Code/agent/examples/burr-conversational-rag/index.test.ts) |
| Streaming overview router | Covered | Safety check, mode routing, streaming side channel, final text transition in [`examples/burr-streaming-overview/index.test.ts`](/Users/davidkpiano/Code/agent/examples/burr-streaming-overview/index.test.ts) |
| Tool calling | Covered | Tool selection as structured text logic, local tool actors, final formatter text logic in [`examples/burr-tool-calling/index.test.ts`](/Users/davidkpiano/Code/agent/examples/burr-tool-calling/index.test.ts) |
| Typed state / structured output | Covered | Schema-derived context/output plus named structured text logic in [`examples/burr-typed-state/index.test.ts`](/Users/davidkpiano/Code/agent/examples/burr-typed-state/index.test.ts) |
| Multi-agent collaboration | Covered | Supervisor routing to typed worker actors in [`examples/burr-multi-agent-collaboration/index.test.ts`](/Users/davidkpiano/Code/agent/examples/burr-multi-agent-collaboration/index.test.ts) |

## Why This Is Different

Burr action definitions are runtime-owned executable steps. `@statelyai/agent` keeps those steps as portable authoring contracts:

- Built-in text actor sources own inline model-call requests; `createTextLogic(...)` owns reusable typed request construction.
- XState `setup(...)` owns typed machine authoring.
- Hosts own model providers, streaming, persistence, tracing, and deployment.

That gives Burr-style individually testable actions without adopting a Burr-style runtime.

## Still Out Of Scope

- Burr UI/tracker parity as a packaged runtime feature
- Python integration packages
- Hamilton/Haystack adapter parity
- published persistence backends beyond XState snapshots and examples
