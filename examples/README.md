# Examples

<!-- example groups derived from examples/*.ts, examples/apps/**, and examples/index.ts -->

This directory is organized by what a developer is trying to do, not by the underlying primitive.

## Start Here

- Building an app route: [`apps/next/`](/Users/davidkpiano/Code/agent/examples/apps/next) or [`apps/cloudflare-agents/`](/Users/davidkpiano/Code/agent/examples/apps/cloudflare-agents)
- Adding durable sessions: [`persistence.ts`](/Users/davidkpiano/Code/agent/examples/persistence.ts) and [`http-session.ts`](/Users/davidkpiano/Code/agent/examples/http-session.ts)
- Streaming text or tool progress: [`next-ai-sdk-ui.ts`](/Users/davidkpiano/Code/agent/examples/next-ai-sdk-ui.ts), [`http-streaming-session.ts`](/Users/davidkpiano/Code/agent/examples/http-streaming-session.ts), and [`tool-calling.ts`](/Users/davidkpiano/Code/agent/examples/tool-calling.ts)
- Studying orchestration patterns: start in `Workflow Examples`

## App-Shaped Examples

These are the best starting points when you want code that already looks like a real app:

- [`apps/next/`](/Users/davidkpiano/Code/agent/examples/apps/next): copy-paste Next.js App Router routes
- [`apps/cloudflare-agents/`](/Users/davidkpiano/Code/agent/examples/apps/cloudflare-agents): copy-paste Cloudflare Agents Worker layout
- [`next-ai-sdk-ui.ts`](/Users/davidkpiano/Code/agent/examples/next-ai-sdk-ui.ts): AI SDK UI route helper
- [`next-app-router.ts`](/Users/davidkpiano/Code/agent/examples/next-app-router.ts): App Router session routes backed by `@statelyai/agent/next` and `@statelyai/agent/http`
- [`cloudflare-agents.ts`](/Users/davidkpiano/Code/agent/examples/cloudflare-agents.ts): Node-safe Cloudflare Agents example backed by `@statelyai/agent/cloudflare`

## Workflow Examples

These focus on real orchestration patterns:

- Session-first interactive workflows
- Durable restore and transport patterns
- Multi-step planning, routing, and handoff flows

- [`persistence.ts`](/Users/davidkpiano/Code/agent/examples/persistence.ts)
- [`persistent-streaming.ts`](/Users/davidkpiano/Code/agent/examples/persistent-streaming.ts)
- [`persistent-supervisor.ts`](/Users/davidkpiano/Code/agent/examples/persistent-supervisor.ts)
- [`persistent-multi-agent-network.ts`](/Users/davidkpiano/Code/agent/examples/persistent-multi-agent-network.ts)
- [`content-creator-flow.ts`](/Users/davidkpiano/Code/agent/examples/content-creator-flow.ts)
- [`email-auto-responder-flow.ts`](/Users/davidkpiano/Code/agent/examples/email-auto-responder-flow.ts)
- [`lead-score-flow.ts`](/Users/davidkpiano/Code/agent/examples/lead-score-flow.ts)
- [`meeting-assistant-flow.ts`](/Users/davidkpiano/Code/agent/examples/meeting-assistant-flow.ts)
- [`self-evaluation-loop-flow.ts`](/Users/davidkpiano/Code/agent/examples/self-evaluation-loop-flow.ts)
- [`spec-agent-loop.ts`](/Users/davidkpiano/Code/agent/examples/spec-agent-loop.ts)
- [`workflow-guardrails.ts`](/Users/davidkpiano/Code/agent/examples/workflow-guardrails.ts)
- [`write-a-book-flow.ts`](/Users/davidkpiano/Code/agent/examples/write-a-book-flow.ts)
- [`plan-and-execute.ts`](/Users/davidkpiano/Code/agent/examples/plan-and-execute.ts)
- [`reflection.ts`](/Users/davidkpiano/Code/agent/examples/reflection.ts)
- [`rewoo.ts`](/Users/davidkpiano/Code/agent/examples/rewoo.ts)
- [`rag.ts`](/Users/davidkpiano/Code/agent/examples/rag.ts)
- [`sql-agent.ts`](/Users/davidkpiano/Code/agent/examples/sql-agent.ts)

## Runtime / Transport Examples

- [`http-session.ts`](/Users/davidkpiano/Code/agent/examples/http-session.ts)
- [`http-streaming-session.ts`](/Users/davidkpiano/Code/agent/examples/http-streaming-session.ts)
- [`cloudflare-durable-object.ts`](/Users/davidkpiano/Code/agent/examples/cloudflare-durable-object.ts)
- [`cloudflare-durable-network.ts`](/Users/davidkpiano/Code/agent/examples/cloudflare-durable-network.ts)

The reusable pieces behind these examples are exported from `@statelyai/agent/http`, `@statelyai/agent/next`, and `@statelyai/agent/cloudflare`.

## Reference / Concept Examples

These are smaller building-block examples:

- One-shot machine execution: [`simple.ts`](/Users/davidkpiano/Code/agent/examples/simple.ts), [`decide.ts`](/Users/davidkpiano/Code/agent/examples/decide.ts), [`classify.ts`](/Users/davidkpiano/Code/agent/examples/classify.ts)
- Interactive session lifecycle: [`chatbot.ts`](/Users/davidkpiano/Code/agent/examples/chatbot.ts), [`chatbot-messages.ts`](/Users/davidkpiano/Code/agent/examples/chatbot-messages.ts), [`hitl.ts`](/Users/davidkpiano/Code/agent/examples/hitl.ts), [`raffle.ts`](/Users/davidkpiano/Code/agent/examples/raffle.ts)

- [`simple.ts`](/Users/davidkpiano/Code/agent/examples/simple.ts)
- [`decide.ts`](/Users/davidkpiano/Code/agent/examples/decide.ts)
- [`classify.ts`](/Users/davidkpiano/Code/agent/examples/classify.ts)
- [`adapter.ts`](/Users/davidkpiano/Code/agent/examples/adapter.ts)
- [`tool-calling.ts`](/Users/davidkpiano/Code/agent/examples/tool-calling.ts)
- [`hitl.ts`](/Users/davidkpiano/Code/agent/examples/hitl.ts)
- [`branching.ts`](/Users/davidkpiano/Code/agent/examples/branching.ts)
- [`subflow.ts`](/Users/davidkpiano/Code/agent/examples/subflow.ts)
- [`conditional-subflow.ts`](/Users/davidkpiano/Code/agent/examples/conditional-subflow.ts)

## Parity Tracking

- [`../docs/langgraph-parity.md`](/Users/davidkpiano/Code/agent/docs/langgraph-parity.md)
- [`../docs/crewai-parity.md`](/Users/davidkpiano/Code/agent/docs/crewai-parity.md)

The parity docs track end-result coverage. The files here are the runnable equivalents.
