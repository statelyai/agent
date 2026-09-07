import { createInMemoryEventLogStore } from "@statelyai/agent";
import { describe, expect, test } from "vitest";
import { recover, runUntilCrash } from "./index.js";

describe("crash-recovery", () => {
  test("recovers from the log alone, re-executing only the in-flight request", async () => {
    const store = createInMemoryEventLogStore();
    const crashed = await runUntilCrash({ store });
    expect(crashed.calls).toBe(2);

    const { recovered, calls } = await recover({ store, threadId: crashed.threadId });
    // The journaled outline call is replayed, not re-executed.
    expect(calls).toBe(1);
    expect(recovered.status).toBe("done");
    expect(recovered.status === "done" ? recovered.output.outline : "").toContain("Intro");
  });

  test("the in-flight request re-executes under the same callKey", async () => {
    const store = createInMemoryEventLogStore();
    const crashed = await runUntilCrash({ store });
    const { replayedCallKey } = await recover({ store, threadId: crashed.threadId });

    expect(crashed.inFlightCallKey).toBeDefined();
    expect(replayedCallKey).toBe(crashed.inFlightCallKey);
  });

  test("the topic survives the crash and the whole thread stays in the log", async () => {
    const store = createInMemoryEventLogStore();
    const crashed = await runUntilCrash({ store, topic: "the history of the fax machine" });
    const { recovered } = await recover({ store, threadId: crashed.threadId });

    expect(recovered.status).toBe("done");
    if (recovered.status !== "done") return;
    expect(recovered.output.topic).toBe("the history of the fax machine");
    expect(recovered.output.article).toContain("the history of the fax machine");

    const stored = await store.read(crashed.threadId);
    expect(stored).toEqual(recovered.events);
  });
});
