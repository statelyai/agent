/**
 * Runs the library's shared `AgentEventLogStore` conformance suite against the
 * Durable Object SQLite store, inside real workerd — so the append/read/
 * conflict/fork semantics are checked on the actual storage engine the host
 * runs on, not a stand-in.
 *
 * The suite asks for a FRESH, EMPTY store per assertion; a new table name per
 * call gives that isolation on one Durable Object's SQL storage.
 */
import { assertEventLogStoreConformance } from "@statelyai/agent";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createDurableObjectEventLogStore } from "../event-log-store.js";

describe("durable object event log store", () => {
  it("satisfies the AgentEventLogStore conformance suite", async () => {
    const namespace = (env as { EmailDrafter: DurableObjectNamespace }).EmailDrafter;
    const stub = namespace.get(namespace.idFromName("event-log-store-conformance"));

    await runInDurableObject(stub, async (_instance, state) => {
      let table = 0;
      await assertEventLogStoreConformance(() =>
        createDurableObjectEventLogStore(state.storage, {
          tableName: `conformance_${table++}`,
        }),
      );
    });
  });

  it("rejects an unusable table name", async () => {
    const namespace = (env as { EmailDrafter: DurableObjectNamespace }).EmailDrafter;
    const stub = namespace.get(namespace.idFromName("event-log-store-names"));

    await runInDurableObject(stub, (_instance, state) => {
      expect(() =>
        createDurableObjectEventLogStore(state.storage, { tableName: "drop table; --" }),
      ).toThrow(/Invalid SQLite table name/);
    });
  });
});
