# Cloudflare Agents host

A Cloudflare Worker that hosts the [email drafter](../email-drafter/agent-logic.ts) agent machine
inside a Durable Object, one DO per conversation.

## The log is the source of truth; a snapshot is only a cache

The Durable Object persists an **append-only journal** of the machine's external inputs — the
reserved `@agent.init` entry, each client event, and each invoke completion — as `AgentLogEntry`
rows in its own SQLite storage. Every wake resumes by folding that journal back through pure
transitions with `runDurableAgent`, which rebuilds the machine state and never re-runs a model call
whose completion is already journaled.

This host therefore stores **no snapshot at all**. A snapshot is only ever a compaction cache over
what the log already implies, so leaving it out costs nothing but a little replay time — and removes
a whole class of failure: a stale, diverged, or no-longer-deserializable snapshot. If a long
conversation ever makes replay too slow, a snapshot can be added back as exactly that, a cache
keyed by log length, and thrown away whenever it disagrees with the log.

Files:

- `event-log-store.ts` — an `AgentEventLogStore` on Durable Object SQLite: one table keyed by
  `(thread_id, idx)`, optimistic `expectedIndex` on append, `AgentEventLogConflictError` on a lost
  race, and `fork` as a copied prefix. It mirrors `@statelyai/agent/sqlite` and is checked against
  the library's shared conformance suite in `test/event-log-store.workers-test.ts`, running in real
  workerd.
- `index.ts` — the Durable Object. One turn = read the journal, `runDurableAgent` from it plus at
  most one client event, append every entry the run journals, settle when the machine waits on a
  human or is done.

## Protocol

Each `:name` is its own Durable Object, i.e. its own conversation and its own log thread.

```
GET  /agents/email-drafter/:name   read the current state
POST /agents/email-drafter/:name   send a machine event, then run until idle
```

WebSocket clients receive `{ type: "state", value, meta }` on each journaled input; `meta` carries
the schema-typed interaction protocol (text / select / confirm) for the current state.

## Run it

```sh
pnpm --filter @statelyai/example-cloudflare-agent-host dev        # keyless, scripted answers
pnpm --filter @statelyai/example-cloudflare-agent-host dev:live   # real model (OPENAI_API_KEY)

curl -X POST localhost:3009/agents/email-drafter/demo \
  -d '{"type":"PROMPT_SUBMITTED","prompt":"Email ana@example.com about Friday'\''s launch"}'
curl -X POST localhost:3009/agents/email-drafter/demo -d '{"type":"SEND"}'
curl -X POST localhost:3009/agents/email-drafter/demo -d '{"type":"END"}'
```

Tests run the Worker in real workerd:

```sh
pnpm --filter @statelyai/example-cloudflare-agent-host test
```

## Library changes this host drove

Building this host surfaced three `runDurableAgent` issues, all now fixed in `src/durable.ts`:

1. **Per-transition hook.** `onEntry(entry, snapshot)` now hands over the live snapshot that entry
   produced, so the websocket broadcast is exact instead of a `replay()` of the log prefix.
2. **Resume dropped journaled invoke completions.** A journaled `xstate.done.actor` carries the
   original incarnation's `sessionId`, which does not match the child a fold re-creates, so the
   completion applied as a no-op and the machine stalled at the state that started the invoke. The
   durable loop now rebinds journal events onto the current fold's children, as `replay()` does.
3. **Unhandled rejection in workerd.** Idle was signalled by throwing a bare `Symbol` out of the
   adapter's `waitForEvent`, which workerd's rejection tracker reported before the drive loop's
   `await` adopted it. Idle is now a returned sentinel event, so nothing rejects.
