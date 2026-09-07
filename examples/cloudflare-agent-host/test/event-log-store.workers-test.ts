/**
 * Runs the library's shared `AgentEventLogStore` conformance suite against the
 * Durable Object SQLite store, inside real workerd — so the append/read/
 * conflict/fork semantics are checked on the actual storage engine the host
 * runs on, not a stand-in.
 *
 * The suite asks for a FRESH, EMPTY store per case; a new table name per
 * `create()` gives that isolation on one Durable Object's SQL storage.
 */
import { assertEventLogStoreConformance } from "@statelyai/agent";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createDurableObjectEventLogStore } from "../event-log-store.js";

const namespace = () => (env as { EmailDrafter: DurableObjectNamespace }).EmailDrafter;

function stubFor(name: string) {
  const ns = namespace();
  return ns.get(ns.idFromName(name));
}

describe("durable object event log store", () => {
  it("satisfies the AgentEventLogStore conformance suite (ctx.storage)", async () => {
    await runInDurableObject(stubFor("event-log-store-conformance"), async (_instance, state) => {
      let table = 0;
      await assertEventLogStoreConformance(() =>
        createDurableObjectEventLogStore(state.storage, { table: `conformance_${table++}` }),
      );
    });
  });

  it("satisfies the conformance suite when handed only ctx.storage.sql", async () => {
    await runInDurableObject(stubFor("event-log-store-conformance-sql"), async (_i, state) => {
      let table = 0;
      await assertEventLogStoreConformance(() =>
        createDurableObjectEventLogStore(state.storage.sql, { table: `sql_only_${table++}` }),
      );
    });
  });

  it("persists across store instances over the same table", async () => {
    await runInDurableObject(stubFor("event-log-store-persistence"), async (_i, state) => {
      const first = createDurableObjectEventLogStore(state.storage, { table: "persisted" });
      await first.append({
        threadId: "t",
        expectedIndex: 0,
        entries: [
          {
            schemaVersion: 1,
            id: "evt_0",
            index: 0,
            recordedAt: "2026-01-01T00:00:00.000Z",
            machineId: "host",
            machineVersion: "v1",
            event: { type: "start" },
          },
        ],
      });

      const second = createDurableObjectEventLogStore(state.storage, { table: "persisted" });
      expect(await second.length("t")).toBe(1);
      expect((await second.read("t"))[0]?.id).toBe("evt_0");
    });
  });

  it("rejects an unusable table name", async () => {
    await runInDurableObject(stubFor("event-log-store-names"), (_i, state) => {
      expect(() =>
        createDurableObjectEventLogStore(state.storage, { table: "drop table; --" }),
      ).toThrow(/Invalid SQLite table name/);
    });
  });
});
