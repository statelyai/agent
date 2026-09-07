import { expect, test } from "vitest";
import { z } from "zod";
import { createInMemoryEventLogStore, runAgent, runAgentLoop, setupAgent } from "./index.js";

test("runAgentLoop drives idle snapshots with host-supplied events", async () => {
  const agent = setupAgent({
    context: z.object({}),
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    events: { NEXT: z.object({}), FINISH: z.object({}) },
  });
  const machine = agent.createMachine({
    context: {},
    initial: "first",
    states: {
      first: { on: { NEXT: { target: "second" } } },
      second: { on: { FINISH: { target: "done" } } },
      done: { type: "final", output: () => ({ ok: true }) },
    },
  });
  const persisted: unknown[] = [];
  const events: Array<{ type: "NEXT" } | { type: "FINISH" }> = [
    { type: "NEXT" },
    { type: "FINISH" },
  ];
  const result = await runAgentLoop(machine, {
    input: {},
    onIdle: async () => events.shift(),
    persist: async (snapshot) => {
      persisted.push(snapshot);
    },
  });
  expect(result.status).toBe("done");
  expect(persisted).toHaveLength(2);
});

test("a store-backed loop seeds `events` on the first turn only", async () => {
  const agent = setupAgent({
    context: z.object({}),
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    events: { NEXT: z.object({}), FINISH: z.object({}) },
  });
  const machine = agent.createMachine({
    id: "stored-loop",
    context: {},
    initial: "first",
    states: {
      first: { on: { NEXT: { target: "second" } } },
      second: { on: { FINISH: { target: "done" } } },
      done: { type: "final", output: () => ({ ok: true }) },
    },
  });

  const store = createInMemoryEventLogStore();
  // A log the caller already holds: it is the thread's log on turn 1, but the
  // store has moved on by turn 2, so re-asserting it would conflict.
  const seeded = await runAgent(machine, { input: {}, store, threadId: "main" });
  expect(seeded.status).toBe("idle");

  const events: Array<{ type: "NEXT" } | { type: "FINISH" }> = [
    { type: "NEXT" },
    { type: "FINISH" },
  ];
  const result = await runAgentLoop(machine, {
    store,
    threadId: "main",
    events: seeded.events,
    onIdle: async () => events.shift(),
  });

  expect(result.status).toBe("done");
  const thread = await store.read("main");
  expect(thread.length).toBeGreaterThan(seeded.events.length);
  expect(thread.map((entry) => entry.event.type)).toContain("FINISH");
});
