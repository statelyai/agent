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

<!-- parity matrix derived from examples/index.ts, src/crewai-equivalents/*.test.ts, and docs/crewai-parity.md scope -->

| CrewAI Flow example | Status | Agent equivalent |
| --- | --- | --- |
| Content Creator Flow | Covered | [`examples/content-creator-flow.ts`](/Users/davidkpiano/Code/agent/examples/content-creator-flow.ts), [`src/crewai-equivalents/content-creator-flow.test.ts`](/Users/davidkpiano/Code/agent/src/crewai-equivalents/content-creator-flow.test.ts) |
| Email Auto Responder Flow | Covered | [`examples/email-auto-responder-flow.ts`](/Users/davidkpiano/Code/agent/examples/email-auto-responder-flow.ts), [`src/crewai-equivalents/email-auto-responder-flow.test.ts`](/Users/davidkpiano/Code/agent/src/crewai-equivalents/email-auto-responder-flow.test.ts) |
| Lead Score Flow | Covered | [`examples/lead-score-flow.ts`](/Users/davidkpiano/Code/agent/examples/lead-score-flow.ts), [`src/crewai-equivalents/lead-score-flow.test.ts`](/Users/davidkpiano/Code/agent/src/crewai-equivalents/lead-score-flow.test.ts) |
| Meeting Assistant Flow | Covered | [`examples/meeting-assistant-flow.ts`](/Users/davidkpiano/Code/agent/examples/meeting-assistant-flow.ts), [`src/crewai-equivalents/meeting-assistant-flow.test.ts`](/Users/davidkpiano/Code/agent/src/crewai-equivalents/meeting-assistant-flow.test.ts) |
| Self Evaluation Loop Flow | Covered | [`examples/self-evaluation-loop-flow.ts`](/Users/davidkpiano/Code/agent/examples/self-evaluation-loop-flow.ts), [`src/crewai-equivalents/self-evaluation-loop-flow.test.ts`](/Users/davidkpiano/Code/agent/src/crewai-equivalents/self-evaluation-loop-flow.test.ts) |
| Write a Book with Flows | Covered | [`examples/write-a-book-flow.ts`](/Users/davidkpiano/Code/agent/examples/write-a-book-flow.ts), [`src/crewai-equivalents/write-a-book-flow.test.ts`](/Users/davidkpiano/Code/agent/src/crewai-equivalents/write-a-book-flow.test.ts) |

## Notes

- CrewAI’s `content_creator_flow/` directory in the current examples repo clone is empty, so that equivalence is based on the current official descriptions: multi-format content routing across blog, LinkedIn, and research outputs.
- Several of these patterns overlap with existing generic examples here, but they are still represented as CrewAI-named examples so the parity surface is explicit instead of inferred.

## Differences

- Logic remains explicit state-machine logic instead of CrewAI decorator-based method routing.
- Session contracts expose snapshots and event journals; production persistence belongs in adapters.
- Fan-out is expressed in plain JavaScript `Promise.all(...)` inside invokes where that is simpler than introducing framework-specific branching primitives.
