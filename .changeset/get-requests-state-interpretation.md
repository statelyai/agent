---
"@statelyai/agent": minor
---

New `runAgent` option: `getRequests`, the override to the default invoke-driven contract. By default, agent work is whatever the machine invokes (`agent.generateText`, TextLogic, `agent.decide`, …). With `getRequests`, whenever the machine would otherwise settle idle, the hook reads the snapshot and returns the model request(s) to run instead, so a plain prose-annotated XState machine with zero invokes (prompts in state `description`s, `meta`, tags, or any lookup you like) runs as an agent unmodified. There is no blessed prompt source: `getRequests` is a recipe seam, and the docs/example ship a copy-paste prompts-in-descriptions recipe.

Each `AgentStateRequest` carries `model` (executor model name), `prompt`, optional `system`, `kind: 'text' | 'decision'`, `allowedEvents`, and an explicit `onDone` advancement contract: a literal event object, or a function of the text output returning the event to send (payload included). No implicit auto-send; omitted `onDone` means a `decide` call chooses among the currently-legal events, gated by `snapshot.can`. Passes run text calls concurrently against a frozen pass-start history, then append to the log and send events sequentially in request order, so the message log is deterministic regardless of executor latency (parallel regions supported).

The run aggregates a message log across requests and stamps it onto every settled `snapshot.messages` (like `agentMeta`), so persist/resume round-trips it with no wiring. Read it with the new `getAgentMessages(snapshot)` accessor; observe it live with the new `onMessage` callback; seed it with `runAgent(..., { messages })`: an array appends to the resumed history, a `(prior) => AgentMessage[]` function takes full control. See examples/described-workflow.
