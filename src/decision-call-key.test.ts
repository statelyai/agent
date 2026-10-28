import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  createAgentRuntime,
  createAgentSchemas,
  createDecisionLogic,
  runToQuiescence,
  setupAgent,
  type AgentDecisionExecutor,
} from "./index.js";
import { createInMemoryEventLogStore } from "./event-log-store.js";

// Each PICK is one decision at the `pick` invoke site. With `stay`, the chosen
// event is handled in place, so the invoke also completes (`xstate.done.actor`).
function createPickMachine({ stay = false } = {}) {
  const schemas = createAgentSchemas({
    context: z.object({ picks: z.number() }),
    events: { PICK: z.object({}), CHOSE: z.object({}) },
  });
  const choose = createDecisionLogic({
    model: "test-model",
    prompt: "Choose.",
    allowedEvents: ["CHOSE"] as const,
  });
  return setupAgent({ schemas, actors: { choose } }).createMachine({
    context: { picks: 0 },
    initial: "waiting",
    states: {
      waiting: { on: { PICK: { target: "picking" } } },
      picking: {
        invoke: {
          id: "pick",
          src: "choose",
          input: {},
          ...(stay ? { onDone: { target: "waiting" } } : {}),
        },
        on: {
          CHOSE: stay
            ? ({ context }) => ({ context: { picks: context.picks + 1 } })
            : ({ context }) => ({ target: "waiting", context: { picks: context.picks + 1 } }),
        },
      },
    },
  });
}

const siteKeys = (keys: Array<string | undefined>) => keys.map((key) => key?.split(":")[1]);

const recording =
  (keys: Array<string | undefined>): AgentDecisionExecutor =>
  async (_request, info) => {
    keys.push(info?.callKey);
    return { event: { type: "CHOSE" } as never };
  };

describe("decision callKeys", () => {
  test.each([
    ["exits the state", false],
    ["stays in the state", true],
  ])("each turn's decision gets its own key when the chosen event %s", async (_label, stay) => {
    const machine = createPickMachine({ stay });
    const store = createInMemoryEventLogStore();
    const keys: Array<string | undefined> = [];
    for (let turn = 0; turn < 3; turn++) {
      const result = await runToQuiescence(
        createAgentRuntime(machine, {
          store,
          threadId: "t",
          executors: { decide: recording(keys) },
        }),
        turn === 0 ? { input: undefined, event: { type: "PICK" } } : { event: { type: "PICK" } },
      );
      expect(result.status).toBe("idle");
      expect(result.snapshot.context).toEqual({ picks: turn + 1 });
    }
    expect(siteKeys(keys)).toEqual(["pick#1.0", "pick#2.0", "pick#3.0"]);
  });

  test("a decision in flight at a crash re-runs under its own key, not the completed one's", async () => {
    const machine = createPickMachine();
    const store = createInMemoryEventLogStore();
    const keys: Array<string | undefined> = [];
    await runToQuiescence(
      createAgentRuntime(machine, { store, threadId: "t", executors: { decide: recording(keys) } }),
      { input: undefined, event: { type: "PICK" } },
    );

    const controller = new AbortController();
    const crashed = runToQuiescence(
      createAgentRuntime(machine, {
        store,
        threadId: "t",
        signal: controller.signal,
        executors: {
          decide: async (_request, info) => {
            keys.push(info?.callKey);
            controller.abort();
            return await new Promise<never>(() => {});
          },
        },
      }),
      { event: { type: "PICK" } },
    );
    expect((await crashed).status).toBe("error");

    const resumed = await runToQuiescence(
      createAgentRuntime(machine, { store, threadId: "t", executors: { decide: recording(keys) } }),
    );
    expect(resumed.snapshot.context).toEqual({ picks: 2 });
    expect(siteKeys(keys)).toEqual(["pick#1.0", "pick#2.0", "pick#2.0"]);
  });
});
