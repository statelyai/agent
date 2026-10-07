# Cloudflare Agents host

A runnable Worker that hosts the [email drafter](../email-drafter/agent-logic.ts) machine in a Cloudflare Agent (a Durable Object), and the reference recipe for a **durable** host.

**The log is the source of truth; no snapshot is persisted.** The Durable Object keeps one append-only event log in its own SQLite storage ([`event-log-store.ts`](./event-log-store.ts)), and that journal is the entire durable state of a conversation. An evicted Durable Object resumes by folding the log back — journaled model and tool results replay, they are never re-executed.

## The turn

Every turn — the first request, each POST, each WebSocket message — is one `runToQuiescence` call:

<!-- runToQuiescence init arguments from src/run-agent.ts -->

```ts
const result = await runToQuiescence(
  createAgentRuntime(machine, {
    store,
    threadId, // used only when the thread's log is empty
    executors,
    onTransition: (snapshot) => broadcast(snapshot),
  }),
  { input, event },
);
```

- `runToQuiescence` reads the thread, runs, and writes back: the store is the whole durable state, and a fresh thread has none and starts from `input`.
- Writes are write-ahead — each entry is durable before the next model call — and each lands at its own index, so the append is optimistic: a concurrent writer conflicts instead of interleaving.
- A rejected write settles `runToQuiescence` with an error result. This host throws that result, and the cached turn is left where the journal is.
- Turns are serialized per Durable Object — one leg at a time.
- A settled turn is cached in memory only. After an eviction it is gone, and the next request folds the log again.

## Protocol

One Durable Object per `:name`, i.e. one conversation.

| Request                            | Effect                                                               |
| ---------------------------------- | -------------------------------------------------------------------- |
| `GET /agents/email-drafter/:name`  | The current view: state, interaction, accepted events, draft, output |
| `POST /agents/email-drafter/:name` | Body is a machine event; validated, then run as one turn             |
| WebSocket on the same path         | Same events; every transition is broadcast as `{ type: "state", … }` |

An event the current state does not accept is a 400 with the current view. A malformed WebSocket frame gets `{ type: "error", issues }` and schedules no turn. A conversation whose log cannot be folded at all reports 500 — there is no state to show.

## Run

```sh
pnpm --filter @statelyai/example-cloudflare-agent-host dev:live   # writes .dev.vars from the repo .env, then dev

curl -X POST localhost:3009/agents/email-drafter/demo \
  -d '{"type":"PROMPT_SUBMITTED","text":"Email ana@x.com about Friday'\''s launch"}'
curl -X POST localhost:3009/agents/email-drafter/demo -d '{"type":"SEND"}'
curl -X POST localhost:3009/agents/email-drafter/demo -d '{"type":"END"}'
```

`OPENAI_API_KEY` and `TYPESAFE_AI_API_KEY` are required: the drafter's prompt check is a Jev judgment, and its evaluation model (`@ai-sdk/typesafe-ai`) is built from the binding like the model provider. Without either binding a turn fails with a 500 naming it. There is no fallback model.

## Test

```sh
pnpm --filter @statelyai/example-cloudflare-agent-host test
```

The suite runs in real workerd. It drives a full cycle across two evictions (asserting the model-call count does not move on resume), checks the journal's shape, and covers the error paths.
