/**
 * A SQLite event-log store — the `AgentEventLogStore` recipe for a SQL database.
 *
 * Built on Node's built-in `node:sqlite` (`DatabaseSync`), so it needs no
 * dependency. The shape carries over to any SQL database:
 *
 *   - One append-only table, primary key `(thread_id, idx)`, entries as JSON
 *     text. JSON text makes every read and write a deep copy.
 *   - `append` is one transaction: check that the thread's length equals
 *     `expectedIndex`, then insert. A stale writer gets
 *     `AgentEventLogConflictError`, so two hosts racing on one thread resolve to
 *     one winner.
 *   - `fork` is one `INSERT ... SELECT` of the prefix onto the new thread.
 *
 * `index.test.ts` runs `assertEventLogStoreConformance` against it. A store
 * that passes is a drop-in for `createInMemoryEventLogStore()`.
 */
import { DatabaseSync } from "node:sqlite";
import { AgentEventLogConflictError, type AgentEventLogStore } from "@statelyai/agent";
import { assertAgentLogEntry, type AgentLogEntry } from "@statelyai/agent/log";

/** `path` is a file path, or `":memory:"` for a throwaway database. */
export function createSqliteEventLogStore(path: string): AgentEventLogStore {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE IF NOT EXISTS agent_event_log (
    thread_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    entry_id TEXT NOT NULL,
    entry TEXT NOT NULL,
    PRIMARY KEY (thread_id, idx),
    UNIQUE (thread_id, entry_id)
  )`);

  const count = db.prepare("SELECT COUNT(*) AS n FROM agent_event_log WHERE thread_id = ?");
  const insert = db.prepare(
    "INSERT INTO agent_event_log (thread_id, idx, entry_id, entry) VALUES (?, ?, ?, ?)",
  );
  const select = db.prepare(
    "SELECT entry FROM agent_event_log WHERE thread_id = ? AND idx >= ? ORDER BY idx",
  );
  const copyPrefix = db.prepare(`INSERT INTO agent_event_log (thread_id, idx, entry_id, entry)
    SELECT ?, idx, entry_id, entry FROM agent_event_log WHERE thread_id = ? AND idx < ?`);

  const lengthOf = (threadId: string) => Number(count.get(threadId)!.n);

  // `DatabaseSync` is synchronous: no `await` can interleave inside `run`, and
  // BEGIN IMMEDIATE takes the write lock, so the check and the insert are atomic
  // across processes sharing the file too.
  const transaction = (run: () => void) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      run();
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  return {
    async append({ threadId, expectedIndex, entries }) {
      entries.forEach((entry, i) => {
        assertAgentLogEntry(entry);
        // Caller misuse, not a race: a plain Error.
        if (entry.index !== expectedIndex + i) {
          throw new Error(`entry.index ${entry.index} must be ${expectedIndex + i}`);
        }
      });
      transaction(() => {
        const length = lengthOf(threadId);
        if (length !== expectedIndex) {
          throw new AgentEventLogConflictError(threadId, expectedIndex, length);
        }
        // A duplicate id violates UNIQUE (thread_id, entry_id) and rolls back.
        for (const entry of entries) {
          insert.run(threadId, entry.index, entry.id, JSON.stringify(entry));
        }
      });
    },

    async read(threadId, options) {
      return select
        .all(threadId, options?.from ?? 0)
        .map((row) => JSON.parse(String(row.entry)) as AgentLogEntry);
    },

    async length(threadId) {
      return lengthOf(threadId);
    },

    async fork({ threadId, newThreadId, upToIndex }) {
      transaction(() => {
        if (lengthOf(newThreadId) > 0) throw new Error(`thread "${newThreadId}" is not empty`);
        const sourceLength = lengthOf(threadId);
        if (sourceLength === 0) throw new Error(`unknown source thread "${threadId}"`);
        const upTo = upToIndex ?? sourceLength;
        // Exclusive, and must keep the init entry at index 0.
        if (!Number.isInteger(upTo) || upTo < 1 || upTo > sourceLength) {
          throw new Error(`upToIndex must be an integer in [1, ${sourceLength}]; got ${upTo}`);
        }
        copyPrefix.run(newThreadId, threadId, upTo);
      });
    },
  };
}
