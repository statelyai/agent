---
"@statelyai/agent": minor
---

**New `@statelyai/agent/sqlite`: durable persistence on Node's built-in `node:sqlite`** — zero new dependencies, Node-only (>= 22.18).

```ts
import { createSqliteEventLogStore } from "@statelyai/agent/sqlite";

const log = createSqliteEventLogStore({ database: "./agent.db" });
await log.append({ threadId: "thread-1", expectedIndex: 0, entries });
log.close();
```

- `createSqliteEventLogStore({ database, tableName? })` is a durable `AgentEventLogStore` that passes `assertEventLogStoreConformance`. Entries live in one table keyed by `(thread_id, idx)` with a unique `(thread_id, entry_id)` index; `append` runs its length check and inserts inside a single `BEGIN IMMEDIATE` transaction, so racing appends resolve to exactly one winner and a stale `expectedIndex` rejects with `AgentEventLogConflictError`.
- `createSqliteSnapshotStore({ database, tableName? })` is an `AgentSnapshotStore` upsert over a `key -> JSON` table.
- `database` takes a file path (or `':memory:'`) to open, or an existing `node:sqlite` `DatabaseSync` handle so both stores can share one connection. `close()` closes only a handle the store opened itself; a passed-in handle stays the caller's to close.
