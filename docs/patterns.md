# Agent patterns

The examples are non-trivial state machines, not special runner APIs.

## Control-flow patterns

- [Evaluator/optimizer](https://github.com/statelyai/agent/blob/next/examples/ai-sdk-evaluator-optimizer)
- [Validate and repair](validate-and-repair.md) ([example](https://github.com/statelyai/agent/blob/next/examples/generate-and-repair))
- [Reflection writer](https://github.com/statelyai/agent/blob/next/examples/reflection-writer)
- [Plan and execute](https://github.com/statelyai/agent/blob/next/examples/plan-and-execute)
- [Corrective RAG](https://github.com/statelyai/agent/blob/next/examples/corrective-rag)
- [Deep research](https://github.com/statelyai/agent/blob/next/examples/deep-research)
- [Guardrails](https://github.com/statelyai/agent/blob/next/examples/guardrails)
- [Hierarchical teams](https://github.com/statelyai/agent/blob/next/examples/hierarchical-teams)
- [Swarm handoff](https://github.com/statelyai/agent/blob/next/examples/swarm-handoff)
- [Parallel streams](https://github.com/statelyai/agent/blob/next/examples/parallel-streams)

## Human and long-running patterns

- [Long-running onboarding](https://github.com/statelyai/agent/blob/next/examples/long-running-onboarding)
- [Snapshot migration](https://github.com/statelyai/agent/blob/next/examples/snapshot-migration)
- [Review tool calls](https://github.com/statelyai/agent/blob/next/examples/review-tool-calls)
- [SQL approval](https://github.com/statelyai/agent/blob/next/examples/sql-agent)
- [Context compaction](https://github.com/statelyai/agent/blob/next/examples/context-compaction)
- [Statechart policy examples](statechart-policy-examples.md): reviewer quorum, booking compensation, and scheduler-driven approval deadlines

## Host portability

The same machine artifact runs through AI SDK, Anthropic, OpenAI, LangChain, Mastra, Cloudflare, Next.js, or plain XState examples. Host adapters supply requests; they do not redefine agent control flow.

Generic orchestration such as fan-out remains ordinary XState composition.
