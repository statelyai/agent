# Examples

These examples use one XState machine artifact across different model SDKs and hosts.

<!-- curated example catalog derived from examples/*/metadata.json and examples/index.ts -->

## Start here

- [email-drafter](email-drafter): typed requests, revision, approval, and sending
- [triage](triage): structured model output
- [twenty-questions](twenty-questions): bounded decision loop
- [plain-xstate](plain-xstate): application-owned XState execution
- [retrofit](retrofit): migrate a hand-written agent loop incrementally
- [json-agent](json-agent): serializable machine configuration
- [portable-xstate-loop](portable-xstate-loop): a native durable XState transition/effect loop

## State-machine advantages

- [guardrails](guardrails), [verification](verification): legal paths and reachability
- [parallel-streams](parallel-streams): concurrent regions
- [hierarchical-teams](hierarchical-teams), [swarm-handoff](swarm-handoff): child machines and handoff
- [long-running-onboarding](long-running-onboarding), [snapshot-migration](snapshot-migration), [crash-recovery](crash-recovery): pauses and native XState snapshots
- [review-tool-calls](review-tool-calls), [sql-agent](sql-agent), [customer-support](customer-support): explicit, persistable human gates
- [context-compaction](context-compaction), [chat-with-pdf](chat-with-pdf): framework-native message history
- [tool-calling](tool-calling): SDK-owned multi-step tools and explicit native message retention; compare [review-tool-calls](review-tool-calls) for machine-gated calls
- [game-loop-agent](game-loop-agent), [chameleon](chameleon), [just-one](just-one): long-lived game rules and hidden state

## Agent patterns

- [ai-sdk-evaluator-optimizer](ai-sdk-evaluator-optimizer)
- [corrective-rag](corrective-rag)
- [deep-research](deep-research)
- [reflection-writer](reflection-writer)
- [plan-and-execute](plan-and-execute)
- [code-assistant](code-assistant)
- [todo-nl](todo-nl)

## Hosts and integrations

`portable-xstate-loop`, `file-snapshot-store`, and `long-lived-actor`
intentionally reuse the same machine artifact under a durable transition loop,
request-scoped snapshot storage, and an application-owned actor.

- [ai-sdk-ui-stream](ai-sdk-ui-stream), [tanstack-ai-stream](tanstack-ai-stream)
- [ai-sdk-game-host](ai-sdk-game-host)
- [anthropic-sdk-host](anthropic-sdk-host), [openai-sdk-host](openai-sdk-host)
- [langchain-host](langchain-host), [mastra-host](mastra-host), [flue-host](flue-host)
- [cloudflare-agent-host](cloudflare-agent-host), [cloudflare-workers-ai-host](cloudflare-workers-ai-host)
- [next-host](next-host)
- [file-snapshot-store](file-snapshot-store): application-owned snapshot persistence
- [long-lived-actor](long-lived-actor): application-owned `createActor` lifetime
- [machine-as-tool](machine-as-tool)
- [braintrust-evals](braintrust-evals)
- [river-crossing](river-crossing)
