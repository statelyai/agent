import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { assertEventLogStoreConformance } from "../event-log-store.js";
import {
  createSqliteEventLogStore,
  createSqliteSnapshotStore,
  type SqliteDatabase,
} from "./index.js";

const tempDir = mkdtempSync(join(tmpdir(), "agent-sqlite-"));
const closers: (() => void)[] = [];

function track<T extends { close(): void }>(store: T): T {
  closers.push(() => store.close());
  return store;
}

afterAll(() => {
  for (const close of closers) {
    try {
      close();
    } catch {
      // Already closed.
    }
  }
  rmSync(tempDir, { recursive: true, force: true });
});

let dbCounter = 0;
const nextFile = () => join(tempDir, `log-${dbCounter++}.sqlite`);

describe("createSqliteEventLogStore conformance", () => {
  test("passes the full conformance suite on a file database", async () => {
    await expect(
      assertEventLogStoreConformance(() =>
        track(createSqliteEventLogStore({ database: nextFile() })),
      ),
    ).resolves.toBeUndefined();
  });

  test("passes the full conformance suite on an in-memory database", async () => {
    await expect(
      assertEventLogStoreConformance(() =>
        track(createSqliteEventLogStore({ database: ":memory:" })),
      ),
    ).resolves.toBeUndefined();
  });
});

describe("createSqliteEventLogStore durability", () => {
  test("entries survive closing and reopening the file", async () => {
    const file = nextFile();
    const first = createSqliteEventLogStore({ database: file });
    await first.append({
      threadId: "t",
      expectedIndex: 0,
      entries: [
        {
          schemaVersion: 1,
          id: "evt_0",
          index: 0,
          recordedAt: "2026-01-01T00:00:00.000Z",
          machineId: "m",
          machineVersion: "v1",
          event: { type: "start" },
        },
      ],
    });
    first.close();

    const reopened = track(createSqliteEventLogStore({ database: file }));
    expect(await reopened.length("t")).toBe(1);
    expect((await reopened.read("t"))[0]!.event).toEqual({ type: "start" });
  });

  test("rejects an unsafe table name", () => {
    expect(() =>
      createSqliteEventLogStore({ database: ":memory:", tableName: "bad name; DROP TABLE x" }),
    ).toThrow(/Invalid SQLite table name/);
  });
});

describe("createSqliteSnapshotStore", () => {
  test("round-trips a snapshot and upserts on save", async () => {
    const store = track(createSqliteSnapshotStore({ database: nextFile() }));
    expect(await store.load("missing")).toBeUndefined();

    const snapshot = { status: "active", value: "idle", context: { count: 1 } } as never;
    await store.save("a", snapshot);
    expect(await store.load("a")).toEqual(snapshot);

    const updated = { status: "done", value: "end", context: { count: 2 } } as never;
    await store.save("a", updated);
    expect(await store.load("a")).toEqual(updated);
    expect(await store.load("b")).toBeUndefined();
  });

  test("isolates stored snapshots from later mutation", async () => {
    const store = track(createSqliteSnapshotStore({ database: ":memory:" }));
    const snapshot = { status: "active", context: { tags: ["a"] } } as never;
    await store.save("a", snapshot);
    (snapshot as unknown as { context: { tags: string[] } }).context.tags.push("mutated");
    expect(await store.load("a")).toEqual({ status: "active", context: { tags: ["a"] } });
  });
});

describe("shared DatabaseSync handle", () => {
  test("both stores run on one caller-owned database", async () => {
    const sqlite = (
      process as unknown as {
        getBuiltinModule: (id: string) => { DatabaseSync: new (path: string) => SqliteDatabase };
      }
    ).getBuiltinModule("node:sqlite");
    const db = new sqlite.DatabaseSync(nextFile());

    const log = createSqliteEventLogStore({ database: db });
    const snapshots = createSqliteSnapshotStore({ database: db });

    await log.append({
      threadId: "t",
      expectedIndex: 0,
      entries: [
        {
          schemaVersion: 1,
          id: "evt_0",
          index: 0,
          recordedAt: "2026-01-01T00:00:00.000Z",
          machineId: "m",
          machineVersion: "v1",
          event: { type: "start" },
        },
      ],
    });
    await snapshots.save("t", { status: "active" } as never);

    expect(await log.length("t")).toBe(1);
    expect(await snapshots.load("t")).toEqual({ status: "active" });

    // A passed-in handle stays the caller's to close.
    log.close();
    snapshots.close();
    expect(await log.length("t")).toBe(1);
    db.close();
  });
});
