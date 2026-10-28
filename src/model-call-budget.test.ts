import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  AGENT_USAGE_EVENT_TYPE,
  createAgentRuntime,
  createAgentSchemas,
  createTextLogic,
  runAgent,
  runToQuiescence,
  setupAgent,
  type AgentUsageEvent,
} from "./index.js";

// A loop of `step` requests that records each `@agent.usage` budget it sees.
function createLoopMachine() {
  const schemas = createAgentSchemas({
    context: z.object({ budgets: z.array(z.unknown()) }),
    input: z.object({}),
    output: z.object({ budgets: z.array(z.unknown()) }),
  });
  const step = createTextLogic({
    schemas: { input: z.object({}), output: z.string() },
    model: "test-model",
    prompt: "step",
  });
  const agent = setupAgent({ schemas, actors: { step } });
  return agent.createMachine({
    context: { budgets: [] },
    initial: "looping",
    on: {
      [AGENT_USAGE_EVENT_TYPE]: ({ context, event }) => ({
        context: { budgets: [...context.budgets, (event as AgentUsageEvent).budget] },
      }),
    },
    states: {
      looping: {
        invoke: {
          src: "step",
          input: {},
          onDone: { target: "looping", reenter: true },
          onError: { target: "spent" },
        },
      },
      spent: { type: "final", output: ({ context }) => context },
    },
  });
}

describe("model-call budget", () => {
  test("a tool loop counts one model call per step, and @agent.usage carries the running budget", async () => {
    let calls = 0;
    const result = await runToQuiescence(
      createAgentRuntime(createLoopMachine(), {
        maxModelCalls: 5,
        executors: {
          generateText: async () => {
            calls += 1;
            return { result: "ok", modelCalls: 3, usage: { totalTokens: 1 } };
          },
        },
      }),
      { input: {} },
    );

    // 3 + 3 steps; the third request is refused (6 > 5 already).
    expect(calls).toBe(2);
    expect(result.usage.modelCalls).toBe(6);
    expect(result.status === "done" ? result.output.budgets : undefined).toEqual([
      { modelCalls: 3, maxModelCalls: 5 },
      { modelCalls: 6, maxModelCalls: 5 },
    ]);
  });

  test("modelCallsSpent counts earlier turns against maxModelCalls but not in this run's usage", async () => {
    let calls = 0;
    const result = await runToQuiescence(
      createAgentRuntime(createLoopMachine(), {
        maxModelCalls: 5,
        modelCallsSpent: 3,
        executors: {
          generateText: async () => {
            calls += 1;
            return { result: "ok", usage: { totalTokens: 1 } };
          },
        },
      }),
      { input: {} },
    );

    expect(calls).toBe(2);
    expect(result.usage.modelCalls).toBe(2);
    expect(result.status === "done" ? result.output.budgets : undefined).toEqual([
      { modelCalls: 4, maxModelCalls: 5 },
      { modelCalls: 5, maxModelCalls: 5 },
    ]);
  });

  test("runAgent with onIdle carries the spent calls into each pass", async () => {
    const schemas = createAgentSchemas({
      context: z.object({ budgets: z.array(z.unknown()) }),
      input: z.object({}),
      output: z.object({ budgets: z.array(z.unknown()) }),
      events: { NEXT: z.object({}) },
    });
    const step = createTextLogic({
      schemas: { input: z.object({}), output: z.string() },
      model: "test-model",
      prompt: "step",
    });
    const machine = setupAgent({ schemas, actors: { step } }).createMachine({
      context: { budgets: [] },
      initial: "working",
      on: {
        [AGENT_USAGE_EVENT_TYPE]: ({ context, event }) => ({
          context: { budgets: [...context.budgets, (event as AgentUsageEvent).budget] },
        }),
      },
      states: {
        working: {
          invoke: {
            src: "step",
            input: {},
            onDone: { target: "waiting" },
            onError: { target: "spent" },
          },
        },
        waiting: { on: { NEXT: { target: "working" } } },
        spent: { type: "final", output: ({ context }) => context },
      },
    });

    const result = await runAgent(machine, {
      input: {},
      maxModelCalls: 2,
      executors: {
        generateText: async () => ({ result: "ok", usage: { totalTokens: 1 } }),
      },
      onIdle: async () => ({ type: "NEXT" as const }),
    });

    expect(result.status === "done" ? result.output.budgets : undefined).toEqual([
      { modelCalls: 1, maxModelCalls: 2 },
      { modelCalls: 2, maxModelCalls: 2 },
    ]);
  });
});
