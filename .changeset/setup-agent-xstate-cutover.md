---
"@statelyai/agent": major
---

Rewrite `@statelyai/agent` as a typed, host-agnostic authoring layer for agent state machines on XState v6. The machine is a portable blueprint: it decides which states exist, which model calls happen, and which events are legal right now; your host executes them with any SDK.

**Authoring**

- `setupAgent({ schemas | context/events/input/output/meta, actors, requests })`: schema-first machine authoring (Standard Schema — Zod, Valibot, ArkType) with typed context, events, invoke inputs/outputs, and state/transition `meta`.
- `createTextLogic(...)` for reusable, schema-typed model calls; co-located `requests:` for inline ones.
- **Decisions**: the model chooses exactly one *currently-legal* machine event. Author state-locally with the `agent.decide` builtin (typed `allowedEvents` against your event schema keys; omitted = all currently-legal events) plus `sendDecision()`, or reusably with `createDecisionLogic(...)`. Core validates (`unknown-event` / `invalid-payload` / `rejected-by-guard` via `snapshot.can`) and retries with attempts fed back to the model; how the model is coerced is adapter business.
- **Machines as data**: full agent workflows — states, transitions, guards, text requests, decisions, human steps — can be defined as pure JSON, validated against the published `@statelyai/agent/agent-workflow.json` schema, and lowered with `setupAgent.fromConfig(...)`. `fromConfig(...)` requires a `compileSchema` option to compile the config's JSON Schemas into runtime validators — bring your own engine (Ajv, @cfworker/json-schema, ...) or pass the exported `minimalSchemaCompiler` to opt into the built-in subset validator (type/properties/required/items/enum/const only).

**Messages**

- `AgentMessage` is a parts-based discriminated union (system/user/assistant/tool with text/image/file/tool-call/tool-result parts), structurally mirroring AI SDK `ModelMessage` with no dependency on `ai`. Adds `toolMessage(...)`; `messagesSchema` validates roles and per-role content shapes.

**Running**

- `runAgent(machine, { input, generateText, streamText?, decide?, ... })`: bind executors, run to settlement, get `{ status: 'done' | 'idle' | 'error' }`. Idle-first human-in-the-loop: waiting states settle `idle` with a JSON-serializable snapshot; resume with `{ snapshot, event }`. Observation-only callbacks (`onTransition`, `onResult`, `onChunk`); `maxModelCalls` budget; `AbortSignal` support; bind-time errors for anything unbound.
- Step path for durable hosts: `initialAgentStep` / `transitionAgentStep` / `resolveAgentStep` / `resolveDecision` give per-model-call checkpoints (Cloudflare Workflows, Temporal, etc.); `step.requests` is a `kind`-discriminated union of text and decision requests; delayed transitions surface as schedulable actions.
- `createAiSdkExecutors({ resolveModel })` from `@statelyai/agent/ai-sdk`: the shipped Vercel AI SDK adapter (structured output, streaming with chunk observation, tool-per-event decide, `metadata.maxSteps` tool loops). `ai` is an optional peer dependency; core depends only on `xstate` (peer).

**Removed / breaking**

- `createAgentMachine(...)`, `@statelyai/agent/local`, and the custom runtime surface: runtime is normal XState actors and snapshots.
- `agentEvents` / `eventTypes` (event tools on text requests) → replaced by decisions and `allowedEvents`.
- `getAvailableEvents` → `getAcceptedEvents`; `getEventTools` and `AgentRequestLogic` removed.
- `runAgent` returns the `done | idle | error` status union instead of the machine output, and never throws on a waiting machine.
- `AgentMessage` is the new union shape; the open index signature is gone. Persisted contexts holding old-shape messages need manual migration.
- Executors return the `{ output }` envelope (see the dedicated changeset); `toolResults` inspection removed.
