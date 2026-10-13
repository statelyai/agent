import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runAgent, setupAgent } from "@statelyai/agent";
import { assertEventLogStoreConformance, replay } from "@statelyai/agent/log";
import { createMockModelExecutors } from "../mock-model.js";
import { createSqliteEventLogStore } from "./index.js";

// The whole contract: one test per conformance case.
void assertEventLogStoreConformance(() => createSqliteEventLogStore(":memory:"), {
  describe,
  it,
});

const summarizer = setupAgent({
  context: z.object({ text: z.string(), summary: z.string().nullable() }),
  input: z.object({ text: z.string() }),
  output: z.object({ summary: z.string() }),
  requests: {
    summarize: {
      schemas: { input: z.object({ text: z.string() }), output: z.string() },
      model: "writer",
      prompt: ({ input }) => `Summarize: ${input.text}`,
    },
  },
}).createMachine({
  id: "summarizer",
  context: ({ input }) => ({ text: input.text, summary: null }),
  initial: "summarizing",
  states: {
    summarizing: {
      invoke: {
        src: "summarize",
        input: ({ context }) => ({ text: context.text }),
        onDone: ({ output }) => ({ target: "done", context: { summary: output.result } }),
      },
    },
    done: { type: "final", output: ({ context }) => ({ summary: context.summary ?? "" }) },
  },
});

describe("runAgent over the SQLite store", () => {
  it("journals the run, and the stored log replays to the same output", async () => {
    const store = createSqliteEventLogStore(":memory:");
    const { generateText } = createMockModelExecutors({ text: { summarize: "Short." } });

    const result = await runAgent(summarizer, {
      store,
      threadId: "t1",
      input: { text: "A long text." },
      executors: { generateText },
    });

    expect(result.status).toBe("done");
    const log = await store.read("t1");
    expect(log).toEqual(result.events);
    expect(replay(summarizer, log).snapshot.output).toEqual({ summary: "Short." });
  });
});
