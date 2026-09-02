import { expect, test } from "vitest";
import { z } from "zod";
import { runAgentLoop, setupAgent } from "./index.js";

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
