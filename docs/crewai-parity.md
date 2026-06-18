# CrewAI Flows Parity

## Scope

This document tracks where `@statelyai/agent` covers the practical workflow patterns shown in the official `crewAIInc/crewAI-examples` Flows directory as of April 26, 2026.

It is intentionally scoped to:

- runnable workflow patterns
- state/routing authoring behavior
- human-in-the-loop and iteration behavior
- examples and tests in this repo

It is intentionally not scoped to:

- CrewAI-specific decorators and class APIs
- CrewAI Enterprise triggers/integrations as products
- Python-only configuration formats

## External reference

CrewAI’s official examples repo currently lists these Flow examples:

- Content Creator Flow
- Email Auto Responder Flow
- Lead Score Flow
- Meeting Assistant Flow
- Self Evaluation Loop Flow
- Write a Book with Flows

Primary sources:

- [CrewAI examples index](https://docs.crewai.com/en/examples/example)
- [CrewAI Flows docs](https://docs.crewai.com/en/concepts/flows)
- [CrewAI examples repo](https://github.com/crewAIInc/crewAI-examples)

## Matrix

<!-- parity matrix derived from src/crewai-equivalents/*.test.ts and docs/crewai-parity.md scope -->

| CrewAI Flow example | Status | Agent equivalent |
| --- | --- | --- |
| Content Creator Flow | Covered | [`src/crewai-equivalents/raw-xstate.test.ts`](/Users/davidkpiano/Code/agent/src/crewai-equivalents/raw-xstate.test.ts) |
| Email Auto Responder Flow | Covered | Same `setupAgent(...).withTasks(...)`/XState primitives as content routing plus persisted XState snapshots |
| Lead Score Flow | Covered | Same `setupAgent(...).withTasks(...)`/XState primitives as HITL review plus typed worker actors |
| Meeting Assistant Flow | Covered | Same `setupAgent(...).withTasks(...)`/XState primitives as fan-out worker actors |
| Self Evaluation Loop Flow | Covered | Same `setupAgent(...).withTasks(...)`/XState primitives as guarded retry/re-entry |
| Write a Book with Flows | Covered | [`src/crewai-equivalents/raw-xstate.test.ts`](/Users/davidkpiano/Code/agent/src/crewai-equivalents/raw-xstate.test.ts) |

## Notes

- CrewAI’s `content_creator_flow/` directory in the current examples repo clone is empty, so that equivalence is based on the current official descriptions: multi-format content routing across blog, LinkedIn, and research outputs.
- Several of these patterns overlap with LangGraph-style examples; they are represented with `setupAgent(...).withTasks(...)`/XState tests so the parity surface is explicit without maintaining duplicate legacy example files.

## Differences

- Logic remains explicit XState logic instead of CrewAI decorator-based method routing.
- Persistence uses normal XState persisted snapshots; production storage belongs in host adapters.
- Fan-out is expressed with normal XState actors or plain JavaScript inside host actors.
