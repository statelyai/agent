# Cloudflare Agents Worker Example

These files show the Cloudflare Agents integration in a real Worker layout with top-level `agents` imports, instead of the Node-safe lazy import used in [`examples/cloudflare-agents.ts`](/Users/davidkpiano/Code/agent/examples/cloudflare-agents.ts).

Included files:

- `src/review-workflow-agent.ts`: the Agent class that owns the durable review workflow
- `src/index.ts`: the Worker entrypoint that delegates requests through `routeAgentRequest(...)`

Use this layout when you want a copy-paste starting point for a real Cloudflare Agents app.
