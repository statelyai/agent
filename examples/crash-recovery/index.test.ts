import { createInMemoryEventLogStore } from "@statelyai/agent/log";
import { describe, expect, test } from "vitest";
import { createMockModelExecutors } from "../mock-model.js";
import { recover, runUntilCrash } from "./index.js";

// The crash leg answers `outline` only: its `draft` call is hung by the example
// itself. The recovery leg answers `draft` only: if the run re-executed the
// journaled `outline` call, the mock would have no answer for it and throw.
function crashExecutors() {
  return createMockModelExecutors({
    text: { outline: (request) => `1. Intro 2. Body 3. Outro — ${request.prompt}` },
  });
}
function recoveryExecutors() {
  return createMockModelExecutors({
    text: { draft: (request) => `Draft based on: ${request.prompt}` },
  });
}

describe("crash-recovery", () => {
  test("recovers from the log alone, re-executing only the in-flight request", async () => {
    const store = createInMemoryEventLogStore();
    const crashed = await runUntilCrash({ store, executors: crashExecutors() });
    expect(crashed.calls).toBe(2);

    const { recovered, calls } = await recover({
      store,
      threadId: crashed.threadId,
      executors: recoveryExecutors(),
    });
    // The journaled outline call is replayed, not re-executed.
    expect(calls).toBe(1);
    expect(recovered.status).toBe("done");
    expect(recovered.status === "done" ? recovered.output.outline : "").toContain("Intro");
  });

  test("the in-flight request re-executes under the same callKey", async () => {
    const store = createInMemoryEventLogStore();
    const crashed = await runUntilCrash({ store, executors: crashExecutors() });
    const { replayedCallKey } = await recover({
      store,
      threadId: crashed.threadId,
      executors: recoveryExecutors(),
    });

    expect(crashed.inFlightCallKey).toBeDefined();
    expect(replayedCallKey).toBe(crashed.inFlightCallKey);
  });

  test("the topic survives the crash and the whole thread stays in the log", async () => {
    const store = createInMemoryEventLogStore();
    const crashed = await runUntilCrash({
      store,
      topic: "the history of the fax machine",
      executors: crashExecutors(),
    });
    const { recovered } = await recover({
      store,
      threadId: crashed.threadId,
      executors: recoveryExecutors(),
    });

    expect(recovered.status).toBe("done");
    if (recovered.status !== "done") return;
    expect(recovered.output.topic).toBe("the history of the fax machine");
    expect(recovered.output.article).toContain("the history of the fax machine");

    const stored = await store.read(crashed.threadId);
    expect(stored).toEqual(recovered.events);
  });

  test("without executors or a key, the run fails naming the missing env var", async () => {
    const key = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await expect(runUntilCrash({ store: createInMemoryEventLogStore() })).rejects.toThrow(
        "OPENAI_API_KEY",
      );
    } finally {
      if (key !== undefined) process.env.OPENAI_API_KEY = key;
    }
  });
});
