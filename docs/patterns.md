# Agent patterns

The examples are non-trivial state machines, not special runner APIs.

## Control-flow patterns

- [Evaluator/optimizer](../examples/ai-sdk-evaluator-optimizer)
- [Reflection writer](../examples/reflection-writer)
- [Plan and execute](../examples/plan-and-execute)
- [Corrective RAG](../examples/corrective-rag)
- [Deep research](../examples/deep-research)
- [Guardrails](../examples/guardrails)
- [Hierarchical teams](../examples/hierarchical-teams)
- [Swarm handoff](../examples/swarm-handoff)
- [Parallel streams](../examples/parallel-streams)

## Human and long-running patterns

- [Long-running onboarding](../examples/long-running-onboarding)
- [Snapshot migration](../examples/snapshot-migration)
- [Review tool calls](../examples/review-tool-calls)
- [SQL approval](../examples/sql-agent)
- [Context compaction](../examples/context-compaction)

## Host portability

The same machine artifact runs through AI SDK, Anthropic, OpenAI, LangChain, Mastra, Flue, Cloudflare, Next.js, or plain XState examples. Host adapters supply requests; they do not redefine agent control flow.

Generic orchestration such as fan-out remains ordinary XState composition.
