/**
 * A file-backed `AgentEventLogStore`: one JSONL file per thread in a
 * directory, one entry per line. run.ts writes every task run here, so the
 * traces outlive the process and the improvement step can read them back.
 *
 * Every operation is synchronous inside its async wrapper, so append's
 * check-and-write has no `await` between reading the length and writing:
 * two appends racing on one `expectedIndex` in the same process resolve to
 * exactly one winner. It is not safe across processes; a database store
 * would hold a `(thread_id, index)` primary key instead.
 * file-store.test.ts runs `assertEventLogStoreConformance` against it.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { AgentEventLogStore, AgentLogEntry } from "@statelyai/agent";
import { AgentEventLogConflictError, assertAgentLogEntry } from "@statelyai/agent/log";

const EXTENSION = ".jsonl";

/** Thread ids hold `/` (`train/v0/slugify`); file names hold none. */
const fileOf = (dir: string, threadId: string) =>
  path.join(dir, `${encodeURIComponent(threadId)}${EXTENSION}`);

export function createFileEventLogStore(dir: string): AgentEventLogStore {
  mkdirSync(dir, { recursive: true });

  const readSync = (threadId: string): AgentLogEntry[] => {
    const file = fileOf(dir, threadId);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf-8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as AgentLogEntry);
  };

  return {
    async append({ threadId, expectedIndex, entries }) {
      entries.forEach((entry, i) => {
        assertAgentLogEntry(entry);
        if (entry.index !== expectedIndex + i) {
          throw new Error(
            `file store: entry.index (${entry.index}) must be contiguous from expectedIndex ` +
              `(${expectedIndex}); expected ${expectedIndex + i} on thread "${threadId}".`,
          );
        }
      });
      const existing = readSync(threadId);
      if (existing.length !== expectedIndex) {
        throw new AgentEventLogConflictError(threadId, expectedIndex, existing.length);
      }
      const ids = new Set(existing.map((entry) => entry.id));
      for (const entry of entries) {
        if (ids.has(entry.id)) {
          throw new Error(`file store: duplicate event id "${entry.id}" in thread "${threadId}".`);
        }
        ids.add(entry.id);
      }
      if (entries.length === 0) return;
      appendFileSync(fileOf(dir, threadId), entries.map((e) => `${JSON.stringify(e)}\n`).join(""));
    },

    async read(threadId, options) {
      return readSync(threadId).slice(options?.from ?? 0);
    },

    async length(threadId) {
      return readSync(threadId).length;
    },

    async fork({ threadId, newThreadId, upToIndex }) {
      if (readSync(newThreadId).length > 0) {
        throw new Error(`file store: newThreadId "${newThreadId}" already has entries.`);
      }
      if (!existsSync(fileOf(dir, threadId))) {
        throw new Error(`file store: unknown source thread "${threadId}".`);
      }
      const source = readSync(threadId);
      const upTo = upToIndex ?? source.length;
      if (!Number.isInteger(upTo) || upTo < 1 || upTo > source.length) {
        throw new Error(
          `file store: upToIndex must be an integer in [1, ${source.length}] on thread ` +
            `"${threadId}"; got ${String(upTo)}.`,
        );
      }
      writeFileSync(
        fileOf(dir, newThreadId),
        source
          .slice(0, upTo)
          .map((entry) => `${JSON.stringify(entry)}\n`)
          .join(""),
      );
    },

    async listThreads(options = {}) {
      const { prefix = "", limit, cursor } = options;
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
        throw new Error(`file store: limit must be a positive integer; got ${String(limit)}.`);
      }
      // The cursor is the last id of the previous page; ids sort by code unit.
      const ids = readdirSync(dir)
        .filter((name) => name.endsWith(EXTENSION))
        .map((name) => decodeURIComponent(name.slice(0, -EXTENSION.length)))
        .filter((id) => id.startsWith(prefix) && readSync(id).length > 0)
        .filter((id) => cursor === undefined || id > cursor)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      if (limit === undefined || ids.length <= limit) return { threadIds: ids };
      const page = ids.slice(0, limit);
      return { threadIds: page, cursor: page[page.length - 1]! };
    },
  };
}
