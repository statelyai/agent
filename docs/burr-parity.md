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

Each row links the migrated example and states the mechanism, not a bare "Covered".

| Burr example pattern | Agent example | Mechanism |
| --- | --- | --- |
| Hello world counter / guarded loop | [`examples/burr-counter/index.test.ts`](/Users/davidkpiano/Code/agent/examples/burr-counter/index.test.ts) | Explicit XState state, guarded re-entrant loop, final-state output |
| Conversational RAG with memory in state | [`examples/burr-conversational-rag/index.test.ts`](/Users/davidkpiano/Code/agent/examples/burr-conversational-rag/index.test.ts) | Retrieval as a typed host actor, memory in machine context, answer as a named request |
| Streaming overview router | [`examples/burr-streaming-overview/index.test.ts`](/Users/davidkpiano/Code/agent/examples/burr-streaming-overview/index.test.ts) | Safety check, mode routing, `runAgent`'s `onChunk` streaming side channel, final text transition |
| Tool calling | [`examples/burr-tool-calling/index.test.ts`](/Users/davidkpiano/Code/agent/examples/burr-tool-calling/index.test.ts) | Tool selection as structured request output, local tool actors, a final formatter request |
| Typed state / structured output | [`examples/burr-typed-state/index.test.ts`](/Users/davidkpiano/Code/agent/examples/burr-typed-state/index.test.ts) | Schema-derived context/output plus a named request with a structured `output` schema |
| Multi-agent collaboration | [`examples/burr-multi-agent-collaboration/index.test.ts`](/Users/davidkpiano/Code/agent/examples/burr-multi-agent-collaboration/index.test.ts) | A routing request's structured output selects among typed worker actors |

Burr-style decision points (an action choosing among a fixed set of next actions) map onto this library's decision primitive — see [`examples/twenty-questions/index.ts`](/Users/davidkpiano/Code/agent/examples/twenty-questions/index.ts) and the readme's Decisions section — though no Burr example in the current upstream set is decision-shaped enough to warrant its own parity row yet.

## Why This Is Different

Burr action definitions are runtime-owned executable steps. `@statelyai/agent` keeps those steps as portable authoring contracts:

- Built-in `agent.generateText`/`agent.streamText`/`agent.decide` actor sources own inline model-call requests; `createTextLogic(...)`/`createDecisionLogic(...)` own reusable typed request construction.
- `setupAgent(...)` (or plain XState `setup(...)`) owns typed machine authoring.
- Hosts own model providers (via `runAgent` executors or `createAiSdkExecutors`), streaming, persistence, tracing, and deployment.

That gives Burr-style individually testable actions without adopting a Burr-style runtime.

## Still Out Of Scope

- Burr UI/tracker parity as a packaged runtime feature
- Python integration packages
- Hamilton/Haystack adapter parity
- Published persistence backends beyond XState snapshots and examples — see the readme's alpha-status list
