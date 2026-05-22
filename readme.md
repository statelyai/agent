# Stately Agent

Stately Agent is the state machine authoring layer for AI agents. Author your AI agents as state machines. Run them anywhere.

The package owns the machine design surface: states, transitions, typed events, messages, generative state schemas, always transitions, and runtime contracts that adapters can implement.

## Examples

<!-- curated examples and CLI commands from examples/index.ts and package.json#scripts -->

The examples in [`examples/`](/Users/davidkpiano/Code/agent/examples) are intentionally small. Most run in the CLI and use real OpenAI calls when `OPENAI_API_KEY` is set. Runtime-specific examples call out extra environment requirements inline.

If you want examples grouped by intent instead of a flat list, start with [`examples/README.md`](/Users/davidkpiano/Code/agent/examples/README.md). It separates app-shaped examples, state-machine workflow examples, local/session examples, and lower-level reference examples.

Run them with `node --import tsx examples/<name>.ts`.

Convert a machine file to diagram output with `pnpm agent:convert <file> --format mermaid` or `pnpm agent:convert <file> --format xstate`. Static analysis warnings are printed to stderr. For programmatic access, use `analyzeGraph(...)` from `@statelyai/agent/graph`; warnings are returned explicitly instead of being hidden in graph metadata.

Start here:

- App-shaped integrations: [`examples/apps/next/`](/Users/davidkpiano/Code/agent/examples/apps/next), [`examples/apps/cloudflare-agents/`](/Users/davidkpiano/Code/agent/examples/apps/cloudflare-agents), [`examples/next-ai-sdk-ui.ts`](/Users/davidkpiano/Code/agent/examples/next-ai-sdk-ui.ts), [`examples/cloudflare-agents.ts`](/Users/davidkpiano/Code/agent/examples/cloudflare-agents.ts)
- Local sessions and transports: [`examples/persistence.ts`](/Users/davidkpiano/Code/agent/examples/persistence.ts), [`examples/http-session.ts`](/Users/davidkpiano/Code/agent/examples/http-session.ts), [`examples/http-streaming-session.ts`](/Users/davidkpiano/Code/agent/examples/http-streaming-session.ts)
- State-machine workflow patterns: [`examples/rag.ts`](/Users/davidkpiano/Code/agent/examples/rag.ts), [`examples/tool-calling.ts`](/Users/davidkpiano/Code/agent/examples/tool-calling.ts), [`examples/error-retry.ts`](/Users/davidkpiano/Code/agent/examples/error-retry.ts), [`examples/spec-agent-loop.ts`](/Users/davidkpiano/Code/agent/examples/spec-agent-loop.ts), [`examples/persistent-supervisor.ts`](/Users/davidkpiano/Code/agent/examples/persistent-supervisor.ts)
- CrewAI-style equivalents: [`examples/content-creator-flow.ts`](/Users/davidkpiano/Code/agent/examples/content-creator-flow.ts), [`examples/email-auto-responder-flow.ts`](/Users/davidkpiano/Code/agent/examples/email-auto-responder-flow.ts), [`examples/lead-score-flow.ts`](/Users/davidkpiano/Code/agent/examples/lead-score-flow.ts), [`examples/meeting-assistant-flow.ts`](/Users/davidkpiano/Code/agent/examples/meeting-assistant-flow.ts), [`examples/self-evaluation-loop-flow.ts`](/Users/davidkpiano/Code/agent/examples/self-evaluation-loop-flow.ts), [`examples/write-a-book-flow.ts`](/Users/davidkpiano/Code/agent/examples/write-a-book-flow.ts)
- Reference examples: [`examples/simple.ts`](/Users/davidkpiano/Code/agent/examples/simple.ts), [`examples/decide.ts`](/Users/davidkpiano/Code/agent/examples/decide.ts), [`examples/classify.ts`](/Users/davidkpiano/Code/agent/examples/classify.ts), [`examples/adapter.ts`](/Users/davidkpiano/Code/agent/examples/adapter.ts), [`examples/email-drafter.ts`](/Users/davidkpiano/Code/agent/examples/email-drafter.ts), [`examples/workflow-guardrails.ts`](/Users/davidkpiano/Code/agent/examples/workflow-guardrails.ts)

Use `classify(...)` when the result is just "what kind of thing is this?" Use `decide(...)` when the result is "what should happen next?" and the chosen branch may need structured data.

CrewAI Flow parity is tracked in [`docs/crewai-parity.md`](/Users/davidkpiano/Code/agent/docs/crewai-parity.md), the same way LangGraph parity is tracked separately.

## Local Adapter

<!-- public local adapter subpath from package.json#exports and src/local/index.ts -->

Use `@statelyai/agent/local` for local development, tests, and in-process examples:

- `execute(machine, state)`: run the local interpreter until done, pending, or error
- `invoke(machine, state)`: run one local interpreter step
- `stream(machine, state)`: yield local interpreter snapshots
- `startSession(machine, options)`: start a local session backed by a `RunStore`
- `restoreSession(machine, options)`: restore a local session from a `RunStore`
- `waitForRunDone(run)`: await terminal success or reject on session error
- `waitForRunSnapshot(run, predicate)`: await the next snapshot that matches a predicate

Production runtimes should consume the session contract or use framework-specific adapter packages such as `@statelyai/agent-cloudflare` when those packages exist.

## Persistence Adapters

<!-- RunStore contract from src/runtime/store.ts and storage examples from examples/cloudflare-*.ts, examples/http-session.ts, and examples/persistence.ts -->

Runtime adapters are intentionally bring-your-own. Implement the `RunStore` contract with four methods:

- `append(sessionId, event)`
- `loadEvents(sessionId, afterSequence?)`
- `loadLatestSnapshot(sessionId)`
- `saveSnapshot(snapshot)`

Use these examples as templates for your storage layer:

- [`examples/persistence.ts`](/Users/davidkpiano/Code/agent/examples/persistence.ts): the smallest local session flow with an in-memory store
- [`examples/http-session.ts`](/Users/davidkpiano/Code/agent/examples/http-session.ts): the Request/Response transport shape around the local adapter
- [`examples/cloudflare-durable-object.ts`](/Users/davidkpiano/Code/agent/examples/cloudflare-durable-object.ts): preview code for a future Cloudflare adapter package
- [`examples/cloudflare-agents.ts`](/Users/davidkpiano/Code/agent/examples/cloudflare-agents.ts): preview code for syncing a `RunStore` into Cloudflare Agents state

**Read the documentation: [stately.ai/docs/agents](https://stately.ai/docs/agents)**
