# Stately Agent

Stately Agent is a flexible framework for building AI agents using state machines. Stately agents go beyond normal LLM-based AI agents by:

- Using state machines to guide the agent's behavior, powered by [XState](https://stately.ai/docs/xstate)
- Incorporating **observations**, **message history**, and **feedback** to the agent decision-making and text-generation processes, as needed
- Enabling custom **planning** abilities for agents to achieve specific goals based on state machine logic, observations, and feedback
- First-class integration with the [Vercel AI SDK](https://sdk.vercel.ai/) to easily support multiple model providers, such as OpenAI, Anthropic, Google, Mistral, Groq, Perplexity, and more

## Examples

<!-- curated examples and CLI commands from examples/index.ts and package.json#scripts -->

The examples in [`examples/`](/Users/davidkpiano/Code/agent/examples) are intentionally small, run in the CLI, and use real OpenAI calls when `OPENAI_API_KEY` is set.

Run them with `node --import tsx examples/<name>.ts`.

Convert a machine file to diagram output with `pnpm agent:convert <file> --format mermaid` or `pnpm agent:convert <file> --format xstate`. Static analysis warnings are printed to stderr. For programmatic access, use `analyzeGraph(...)` from `@statelyai/agent/graph`; warnings are returned explicitly instead of being hidden in graph metadata.

Each example demonstrates one concept:

- [`examples/simple.ts`](/Users/davidkpiano/Code/agent/examples/simple.ts): the smallest `createAgentMachine(...)` flow with an `invoke` state that makes a real LLM call
- [`examples/hitl.ts`](/Users/davidkpiano/Code/agent/examples/hitl.ts): a human-in-the-loop machine that pauses in a pending state, accepts typed events, and drafts with an LLM after approval
- [`examples/error-retry.ts`](/Users/davidkpiano/Code/agent/examples/error-retry.ts): retrying transient invoke failures through explicit internal error events
- [`examples/conditional-subflow.ts`](/Users/davidkpiano/Code/agent/examples/conditional-subflow.ts): routing directly into one of multiple child subflows from parent input
- [`examples/tool-calling.ts`](/Users/davidkpiano/Code/agent/examples/tool-calling.ts): tool invocation with emitted `toolCall`, incremental `toolProgress`, and final `toolResult` events
- [`examples/persistence.ts`](/Users/davidkpiano/Code/agent/examples/persistence.ts): persisting snapshots and restoring a session in plain runtime code
- [`examples/persistent-multi-agent-network.ts`](/Users/davidkpiano/Code/agent/examples/persistent-multi-agent-network.ts): durable multi-agent handoffs that restore from a persisted mid-network snapshot
- [`examples/cloudflare-durable-network.ts`](/Users/davidkpiano/Code/agent/examples/cloudflare-durable-network.ts): a Cloudflare Durable Object runner that starts and resumes a persisted multi-agent network
- [`examples/decide.ts`](/Users/davidkpiano/Code/agent/examples/decide.ts): choosing the next branch with structured branch-specific payloads
- [`examples/classify.ts`](/Users/davidkpiano/Code/agent/examples/classify.ts): routing into a fixed category set when you only need a label
- [`examples/adapter.ts`](/Users/davidkpiano/Code/agent/examples/adapter.ts): plugging in a custom adapter that still uses a real OpenAI model under the hood

Use `classify(...)` when the result is just "what kind of thing is this?" Use `decide(...)` when the result is "what should happen next?" and the chosen branch may need structured data.

**Read the documentation: [stately.ai/docs/agents](https://stately.ai/docs/agents)**
