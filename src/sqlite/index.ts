/**
 * SQLite-backed persistence built on Node's built-in `node:sqlite` — no
 * dependencies, Node-only (>= 22.18). Two stores, both usable on one database
 * handle: {@link createSqliteEventLogStore} (the durable `AgentEventLogStore`)
 * and {@link createSqliteSnapshotStore} (the idle-point `AgentSnapshotStore`
 * compaction cache).
 */
import type { Snapshot } from "xstate";
import {
  AgentEventLogConflictError,
  assertAgentLogEntry,
  type AgentEventLogStore,
  type AgentLogEntry,
} from "../event-log-store.js";
import type { AgentSnapshotStore } from "../types.js";

// ─── node:sqlite structural types ───
//
// The repo pins @types/node@20, which predates `node:sqlite`. Rather than bump
// deps, these minimal structural shapes describe exactly what the stores use;
// a real `DatabaseSync` from a newer @types/node is assignable to
// {@link SqliteDatabase}.

/** A prepared statement, structurally compatible with `node:sqlite`'s `StatementSync`. */
export interface SqliteStatement {
  run(...params: any[]): unknown;
  all(...params: any[]): unknown[];
  get(...params: any[]): unknown;
}

/** A database handle, structurally compatible with `node:sqlite`'s `DatabaseSync`. */
export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}

interface SqliteDatabaseConstructor {
  new (path: string): SqliteDatabase;
}

function openDatabase(path: string): SqliteDatabase {
  // `process.getBuiltinModule` (Node >= 22.3) loads `node:sqlite` without a
  // static import, so the ESM and CJS builds behave identically and the module
  // is only touched when a path (rather than a handle) is passed.
  const sqlite = (
    process as unknown as {
      getBuiltinModule?: (id: string) => { DatabaseSync: SqliteDatabaseConstructor } | undefined;
    }
  ).getBuiltinModule?.("node:sqlite");
  if (!sqlite?.DatabaseSync) {
    throw new Error(
      "createSqlite*Store: 'node:sqlite' is unavailable in this runtime; Node >= 22.18 is required.",
    );
  }
  return new sqlite.DatabaseSync(path);
}

/** A store that owns nothing unless it opened the file itself.
 *
 * Exported because it appears in the store factories' return types — without
 * it, consumers' declaration emit fails with TS4058 "cannot be named". */
export interface Closable {
  /**
   * Closes the underlying database — but only when this store opened it from a
   * path. When a `DatabaseSync` handle was passed in, the caller owns it and
   * this is a no-op.
   */
  close(): void;
}

export interface SqliteStoreOptions {
  /** A file path (or `':memory:'`) to open, or an existing `node:sqlite` handle to share. */
  database: string | SqliteDatabase;
}

export interface SqliteEventLogStoreOptions extends SqliteStoreOptions {
  /** Table holding the log entries. Defaults to `agent_event_log`. */
  tableName?: string;
}

export interface SqliteSnapshotStoreOptions extends SqliteStoreOptions {
  /** Table holding the snapshots. Defaults to `agent_snapshots`. */
  tableName?: string;
}

function quoteIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(
      `Invalid SQLite table name '${name}': use letters, digits, and underscores only.`,
    );
  }
  return `"${name}"`;
}

function resolveDatabase(database: string | SqliteDatabase): {
  db: SqliteDatabase;
  owned: boolean;
} {
  return typeof database === "string"
    ? { db: openDatabase(database), owned: true }
    : { db: database, owned: false };
}

/**
 * An {@link AgentEventLogStore} on one SQLite table, keyed by
 * `(thread_id, idx)` with a unique `(thread_id, entry_id)` index. Entries are
 * stored as JSON text, so reads and writes are deep copies by construction.
 * `append` runs its length check and inserts inside one `BEGIN IMMEDIATE`
 * transaction: `node:sqlite` is synchronous, so no `await` interleaves between
 * the check and the write and racing appends resolve to exactly one winner.
 */
export function createSqliteEventLogStore(
  options: SqliteEventLogStoreOptions,
): AgentEventLogStore & Closable {
  const { db, owned } = resolveDatabase(options.database);
  const table = quoteIdentifier(options.tableName ?? "agent_event_log");

  db.exec(`
    CREATE TABLE IF NOT EXISTS ${table} (
      thread_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      entry_id TEXT NOT NULL,
      entry TEXT NOT NULL,
      PRIMARY KEY (thread_id, idx)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(
      `${options.tableName ?? "agent_event_log"}_thread_entry_id`,
    )} ON ${table} (thread_id, entry_id);
  `);

  const lengthOf = (threadId: string): number => {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE thread_id = ?`)
      .get(threadId) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  };

  const transact = <T>(fn: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The transaction was already rolled back; keep the original error.
      }
      throw error;
    }
  };

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

      transact(() => {
        const length = lengthOf(threadId);
        if (length !== expectedIndex) {
          throw new AgentEventLogConflictError(threadId, expectedIndex, length);
        }
        const insert = db.prepare(
          `INSERT INTO ${table} (thread_id, idx, entry_id, entry) VALUES (?, ?, ?, ?)`,
        );
        for (const entry of entries) {
          try {
            insert.run(threadId, entry.index, entry.id, JSON.stringify(entry));
          } catch (error) {
            if (String((error as Error).message).includes("UNIQUE")) {
              throw new Error(
                `AgentEventLogStore.append: duplicate event id "${entry.id}" in thread "${threadId}".`,
              );
            }
            throw error;
          }
        }
      });
    },

    async read(threadId, options) {
      const from = options?.from ?? 0;
      const rows = db
        .prepare(`SELECT entry FROM ${table} WHERE thread_id = ? AND idx >= ? ORDER BY idx ASC`)
        .all(threadId, from) as { entry: string }[];
      return rows.map((row) => JSON.parse(row.entry) as AgentLogEntry);
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
        db.prepare(
          `INSERT INTO ${table} (thread_id, idx, entry_id, entry)
           SELECT ?, idx, entry_id, entry FROM ${table} WHERE thread_id = ? AND idx < ?`,
        ).run(newThreadId, threadId, upTo);
      });
    },

    close() {
      if (owned) db.close();
    },
  };
}

/**
 * An {@link AgentSnapshotStore} on one SQLite table: a `key -> JSON` upsert.
 * Snapshots are the compaction cache over the event log, so `save` overwrites
 * whatever the id previously held.
 */
export function createSqliteSnapshotStore(
  options: SqliteSnapshotStoreOptions,
): AgentSnapshotStore & Closable {
  const { db, owned } = resolveDatabase(options.database);
  const table = quoteIdentifier(options.tableName ?? "agent_snapshots");

  db.exec(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id TEXT PRIMARY KEY,
      snapshot TEXT NOT NULL
    );
  `);

  return {
    async load(id) {
      const row = db.prepare(`SELECT snapshot FROM ${table} WHERE id = ?`).get(id) as
        | { snapshot: string }
        | undefined;
      return row === undefined ? undefined : (JSON.parse(row.snapshot) as Snapshot<unknown>);
    },

    async save(id, snapshot) {
      db.prepare(
        `INSERT INTO ${table} (id, snapshot) VALUES (?, ?)
         ON CONFLICT(id) DO UPDATE SET snapshot = excluded.snapshot`,
      ).run(id, JSON.stringify(snapshot));
    },

    close() {
      if (owned) db.close();
    },
  };
}
