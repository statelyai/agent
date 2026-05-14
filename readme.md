# Stately Agent

Stately Agent is a flexible framework for building AI agents using state machines. Stately agents go beyond normal LLM-based AI agents by:

- Using state machines to guide the agent's behavior, powered by [XState](https://stately.ai/docs/xstate)
- Incorporating **observations**, **message history**, and **feedback** to the agent decision-making and text-generation processes, as needed
- Enabling custom **planning** abilities for agents to achieve specific goals based on state machine logic, observations, and feedback
- First-class integration with the [Vercel AI SDK](https://sdk.vercel.ai/) to easily support multiple model providers, such as OpenAI, Anthropic, Google, Mistral, Groq, Perplexity, and more

## Examples

<!-- curated examples and CLI commands from examples/index.ts and package.json#scripts -->

The examples in [`examples/`](/Users/davidkpiano/Code/agent/examples) are intentionally small. Most run in the CLI and use real OpenAI calls when `OPENAI_API_KEY` is set. Runtime-specific examples call out extra environment requirements inline.

If you want examples grouped by intent instead of a flat list, start with [`examples/README.md`](/Users/davidkpiano/Code/agent/examples/README.md). It separates app-shaped examples, workflow examples, runtime integrations, and lower-level reference examples.

Run them with `node --import tsx examples/<name>.ts`.

Convert a machine file to diagram output with `pnpm agent:convert <file> --format mermaid` or `pnpm agent:convert <file> --format xstate`. Static analysis warnings are printed to stderr. For programmatic access, use `analyzeGraph(...)` from `@statelyai/agent/graph`; warnings are returned explicitly instead of being hidden in graph metadata.

Start here:

- App-shaped integrations: [`examples/apps/next/`](/Users/davidkpiano/Code/agent/examples/apps/next), [`examples/apps/cloudflare-agents/`](/Users/davidkpiano/Code/agent/examples/apps/cloudflare-agents), [`examples/next-ai-sdk-ui.ts`](/Users/davidkpiano/Code/agent/examples/next-ai-sdk-ui.ts), [`examples/cloudflare-agents.ts`](/Users/davidkpiano/Code/agent/examples/cloudflare-agents.ts)
- Durable sessions and transports: [`examples/persistence.ts`](/Users/davidkpiano/Code/agent/examples/persistence.ts), [`examples/http-session.ts`](/Users/davidkpiano/Code/agent/examples/http-session.ts), [`examples/http-streaming-session.ts`](/Users/davidkpiano/Code/agent/examples/http-streaming-session.ts)
- Core workflow patterns: [`examples/rag.ts`](/Users/davidkpiano/Code/agent/examples/rag.ts), [`examples/tool-calling.ts`](/Users/davidkpiano/Code/agent/examples/tool-calling.ts), [`examples/error-retry.ts`](/Users/davidkpiano/Code/agent/examples/error-retry.ts), [`examples/spec-agent-loop.ts`](/Users/davidkpiano/Code/agent/examples/spec-agent-loop.ts), [`examples/persistent-supervisor.ts`](/Users/davidkpiano/Code/agent/examples/persistent-supervisor.ts)
- CrewAI-style equivalents: [`examples/content-creator-flow.ts`](/Users/davidkpiano/Code/agent/examples/content-creator-flow.ts), [`examples/email-auto-responder-flow.ts`](/Users/davidkpiano/Code/agent/examples/email-auto-responder-flow.ts), [`examples/lead-score-flow.ts`](/Users/davidkpiano/Code/agent/examples/lead-score-flow.ts), [`examples/meeting-assistant-flow.ts`](/Users/davidkpiano/Code/agent/examples/meeting-assistant-flow.ts), [`examples/self-evaluation-loop-flow.ts`](/Users/davidkpiano/Code/agent/examples/self-evaluation-loop-flow.ts), [`examples/write-a-book-flow.ts`](/Users/davidkpiano/Code/agent/examples/write-a-book-flow.ts)
- Reference examples: [`examples/simple.ts`](/Users/davidkpiano/Code/agent/examples/simple.ts), [`examples/decide.ts`](/Users/davidkpiano/Code/agent/examples/decide.ts), [`examples/classify.ts`](/Users/davidkpiano/Code/agent/examples/classify.ts), [`examples/adapter.ts`](/Users/davidkpiano/Code/agent/examples/adapter.ts)

Use `classify(...)` when the result is just "what kind of thing is this?" Use `decide(...)` when the result is "what should happen next?" and the chosen branch may need structured data.

CrewAI Flow parity is tracked in [`docs/crewai-parity.md`](/Users/davidkpiano/Code/agent/docs/crewai-parity.md), the same way LangGraph parity is tracked separately.

## Runtime Adapters

<!-- public runtime adapter subpaths from package.json#exports and src/{runtime,http,next,cloudflare}/index.ts -->

The core package exports session helpers from `@statelyai/agent` and `@statelyai/agent/runtime`:

- `waitForRunDone(run)`: await terminal success or reject on session error
- `waitForRunSnapshot(run, predicate)`: await the next snapshot that matches a predicate

Use the framework adapters when a machine needs to run inside an app runtime:

- `@statelyai/agent/http`: `createSessionHttpController(...)`, `createSessionHttpHandler(...)`, and `createRunSseResponse(...)`
- `@statelyai/agent/next`: `createNextSessionRouteHandlers(...)` plus App Router config exports
- `@statelyai/agent/cloudflare`: `createDurableObjectRunStore(...)` and `createCloudflareAgentRunStore(...)`

## Persistence Adapters

<!-- RunStore contract from src/runtime/store.ts and storage examples from examples/cloudflare-*.ts, examples/http-session.ts, and examples/persistence.ts -->

Storage adapters are intentionally bring-your-own. Implement the `RunStore` contract with four methods:

- `append(sessionId, event)`
- `loadEvents(sessionId, afterSequence?)`
- `loadLatestSnapshot(sessionId)`
- `saveSnapshot(snapshot)`

Use these examples as templates for your storage layer:

- [`examples/persistence.ts`](/Users/davidkpiano/Code/agent/examples/persistence.ts): the smallest durable session flow with an in-memory store
- [`examples/http-session.ts`](/Users/davidkpiano/Code/agent/examples/http-session.ts): the Request/Response transport shape around `@statelyai/agent/http`
- [`examples/cloudflare-durable-object.ts`](/Users/davidkpiano/Code/agent/examples/cloudflare-durable-object.ts): Durable Object-backed event and snapshot persistence with `@statelyai/agent/cloudflare`
- [`examples/cloudflare-agents.ts`](/Users/davidkpiano/Code/agent/examples/cloudflare-agents.ts): syncing a `RunStore` into Cloudflare Agents state with `@statelyai/agent/cloudflare`

**Read the documentation: [stately.ai/docs/agents](https://stately.ai/docs/agents)**
