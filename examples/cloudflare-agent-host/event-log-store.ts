/// <reference types="@cloudflare/workers-types" />
/**
 * An {@link AgentEventLogStore} backed by Durable Object SQLite storage.
 *
 * This is the host's durability artifact: the append-only journal of external
 * inputs IS the source of truth for a conversation. A snapshot, if one is kept
 * at all, is only a compaction cache over what this log already implies.
 *
 * The shape: one table keyed by `(thread_id, idx)` with a unique
 * `(thread_id, entry_id)` index, entries stored as JSON text (so reads and
 * writes are deep copies by construction), and an optimistic `expectedIndex`
 * on append that rejects with {@link AgentEventLogConflictError} when a
 * concurrent writer got there first.
 *
 * Durable Object SQL (`ctx.storage.sql.exec`) is synchronous, so no `await`
 * interleaves between the length check and the insert: two appends racing on
 * the same `expectedIndex` resolve to exactly one winner, and every write a
 * synchronous block performs commits as one implicit transaction. When the
 * full `ctx.storage` is passed, `transactionSync` makes that all-or-nothing
 * guarantee explicit (and rolls the batch back on a mid-append throw).
 *
 * It lives in the example rather than the library because it is host-specific
 * glue: the contract it implements (`AgentEventLogStore`) is the library's, and
 * the shared conformance suite (`assertEventLogStoreConformance`) checks that
 * this implementation really honors it — see `test/event-log-store.workers-test.ts`.
 */
import {
  AgentEventLogConflictError,
  assertAgentLogEntry,
  type AgentEventLogStore,
  type AgentLogEntry,
} from "@statelyai/agent";

export interface DurableObjectEventLogStoreOptions {
  /** Table holding the log entries. Defaults to `agent_event_log`. */
  table?: string;
}

/**
 * Either half of a Durable Object's storage API is accepted: `ctx.storage.sql`
 * (all this store strictly needs) or the whole `ctx.storage`, which also
 * carries `transactionSync` for an explicit all-or-nothing multi-entry append.
 */
export type DurableObjectEventLogStorage = SqlStorage | DurableObjectStorage;

function quoteIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(
      `Invalid SQLite table name '${name}': use letters, digits, and underscores only.`,
    );
  }
  return `"${name}"`;
}

/**
 * Creates the store on a Durable Object's SQL storage.
 *
 * `storage` is the DO's `ctx.storage.sql` (or `ctx.storage`); the table is
 * created on first use, so the same DO can hold this log alongside whatever
 * else it stores.
 */
export function createDurableObjectEventLogStore(
  storage: DurableObjectEventLogStorage,
  options: DurableObjectEventLogStoreOptions = {},
): AgentEventLogStore {
  const sql: SqlStorage = "sql" in storage ? storage.sql : storage;
  // `transactionSync` only exists on the full storage object; without it the
  // synchronous block is still one implicit transaction in workerd, but an
  // explicit one also unwinds partial inserts when a guard throws mid-batch.
  const transact: (run: () => void) => void =
    "transactionSync" in storage ? (run) => storage.transactionSync(run) : (run) => run();

  const name = options.table ?? "agent_event_log";
  const table = quoteIdentifier(name);
  const index = quoteIdentifier(`${name}_thread_entry_id`);

  sql.exec(
    `CREATE TABLE IF NOT EXISTS ${table} (
       thread_id TEXT NOT NULL,
       idx INTEGER NOT NULL,
       entry_id TEXT NOT NULL,
       entry TEXT NOT NULL,
       PRIMARY KEY (thread_id, idx)
     )`,
  );
  sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${index} ON ${table} (thread_id, entry_id)`);

  const lengthOf = (threadId: string): number => {
    const row = sql.exec(`SELECT COUNT(*) AS n FROM ${table} WHERE thread_id = ?`, threadId).one();
    return Number(row.n ?? 0);
  };

  const entryIdsOf = (threadId: string): Set<string> =>
    new Set(
      sql
        .exec(`SELECT entry_id FROM ${table} WHERE thread_id = ?`, threadId)
        .toArray()
        .map((row) => String(row.entry_id)),
    );

  return {
    async append({ threadId, expectedIndex, entries }) {
      for (const entry of entries) {
        assertAgentLogEntry(entry);
      }
      for (let i = 0; i < entries.length; i++) {
        if (entries[i]!.index !== expectedIndex + i) {
          throw new Error(
            `AgentEventLogStore.append: entry.index (${entries[i]!.index}) must be contiguous ` +
              `from expectedIndex (${expectedIndex}); expected ${expectedIndex + i} at position ${i} ` +
              `on thread "${threadId}".`,
          );
        }
      }

      // No `await` from here to the insert: the check and the write are one
      // synchronous critical section, so racing appends cannot both win.
      transact(() => {
        const length = lengthOf(threadId);
        if (length !== expectedIndex) {
          throw new AgentEventLogConflictError(threadId, expectedIndex, length);
        }
        // Duplicate ids are checked up front rather than caught off the unique
        // index: the index is the integrity backstop, this is the diagnosable
        // error the contract asks for.
        const ids = entryIdsOf(threadId);
        for (const entry of entries) {
          if (ids.has(entry.id)) {
            throw new Error(
              `AgentEventLogStore.append: duplicate event id "${entry.id}" in thread "${threadId}".`,
            );
          }
          ids.add(entry.id);
        }
        for (const entry of entries) {
          sql.exec(
            `INSERT INTO ${table} (thread_id, idx, entry_id, entry) VALUES (?, ?, ?, ?)`,
            threadId,
            entry.index,
            entry.id,
            JSON.stringify(entry),
          );
        }
      });
    },

    async read(threadId, readOptions) {
      const from = readOptions?.from ?? 0;
      return sql
        .exec(
          `SELECT entry FROM ${table} WHERE thread_id = ? AND idx >= ? ORDER BY idx ASC`,
          threadId,
          from,
        )
        .toArray()
        .map((row) => JSON.parse(String(row.entry)) as AgentLogEntry);
    },

    async length(threadId) {
      return lengthOf(threadId);
    },

    async fork({ threadId, newThreadId, upToIndex }) {
      transact(() => {
        if (lengthOf(newThreadId) > 0) {
          throw new Error(
            `AgentEventLogStore.fork: newThreadId "${newThreadId}" already has entries.`,
          );
        }
        const sourceLength = lengthOf(threadId);
        if (sourceLength === 0) {
          throw new Error(`AgentEventLogStore.fork: unknown source thread "${threadId}".`);
        }
        const upTo = upToIndex ?? sourceLength;
        if (upTo < 0 || upTo > sourceLength) {
          throw new Error(
            `AgentEventLogStore.fork: thread "${threadId}" (length ${sourceLength}) ` +
              `has no index ${upTo} to fork up to.`,
          );
        }
        sql.exec(
          `INSERT INTO ${table} (thread_id, idx, entry_id, entry)
           SELECT ?, idx, entry_id, entry FROM ${table} WHERE thread_id = ? AND idx < ?`,
          newThreadId,
          threadId,
          upTo,
        );
      });
    },
  };
}
