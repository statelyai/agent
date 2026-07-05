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

<!-- parity matrix derived from the consolidated pattern examples and docs/crewai-parity.md scope -->

Each row links the migrated example (where one exists as its own file) and states the mechanism.

| CrewAI Flow example | Agent example | Mechanism |
| --- | --- | --- |
| Content Creator Flow | [`examples/supervisor/index.test.ts`](/Users/davidkpiano/Code/agent/examples/supervisor/index.test.ts) | A routing request's structured output selects a format-specific writer request (the dedicated content-creator port was consolidated into supervisor) |
| Write a Book with Flows | [`examples/ai-sdk-orchestrator-worker/index.test.ts`](/Users/davidkpiano/Code/agent/examples/ai-sdk-orchestrator-worker/index.test.ts) | An outline request, then `Promise.all(...)` fan-out over per-chapter worker requests inside a host actor (the dedicated write-a-book port was consolidated into the AI SDK orchestrator-worker fan-out example) |
| Email Auto Responder Flow | — | Possible but not a dedicated example: same content-routing mechanism as Content Creator Flow, plus a persisted snapshot per thread (see [`examples/human-in-the-loop/index.test.ts`](/Users/davidkpiano/Code/agent/examples/human-in-the-loop/index.test.ts) for the persistence half) |
| Lead Score Flow | — | Possible but not a dedicated example: idle-first HITL review (see [`examples/human-in-the-loop/index.test.ts`](/Users/davidkpiano/Code/agent/examples/human-in-the-loop/index.test.ts)) plus typed worker actors |
| Meeting Assistant Flow | — | Possible but not a dedicated example: `Promise.all(...)` fan-out over worker actors, same pattern as Write a Book (see [`examples/ai-sdk-orchestrator-worker/index.test.ts`](/Users/davidkpiano/Code/agent/examples/ai-sdk-orchestrator-worker/index.test.ts) for the general fan-out shape) |
| Self Evaluation Loop Flow | — | Possible but not a dedicated example: guarded retry/re-entry, same pattern as [`examples/ai-sdk-evaluator-optimizer/index.test.ts`](/Users/davidkpiano/Code/agent/examples/ai-sdk-evaluator-optimizer/index.test.ts) |

## Notes

- CrewAI's `content_creator_flow/` directory in the current examples repo clone is empty, so that equivalence is based on the current official descriptions: multi-format content routing across blog, LinkedIn, and research outputs.
- Rows without a dedicated example file are marked "possible but not a dedicated example" rather than "Covered" — the underlying XState pattern is proven elsewhere in this repo (linked), but no CrewAI-specific example exercises it end to end. Treat those as an honest gap, not a claim. (The former per-flow `crewai-*` ports were consolidated into the shared pattern examples linked above.)

## Differences

- Logic remains explicit `setupAgent(...)`/XState logic instead of CrewAI decorator-based method routing.
- Persistence uses normal XState persisted snapshots; production storage belongs in host adapters (no shipped storage package — see [`langgraph-gaps.md`](/Users/davidkpiano/Code/agent/docs/langgraph-gaps.md)).
- Fan-out is expressed with `Promise.all(...)` inside a host actor; there is no dedicated fan-out primitive yet.
