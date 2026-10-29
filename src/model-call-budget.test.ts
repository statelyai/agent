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
  type AgentTraceEvent,
  type AgentUsageEvent,
  type ChosenEvent,
} from "./index.js";
import { traceSteps } from "./internal/trace-states.js";

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

  test("a tool loop that throws after some steps still counts them", async () => {
    const result = await runToQuiescence(
      createAgentRuntime(createLoopMachine(), {
        executors: {
          generateText: async () => {
            throw Object.assign(new Error("bad final output"), { modelCalls: 4 });
          },
        },
      }),
      { input: {} },
    );

    expect(result.status).toBe("done");
    expect(result.usage.modelCalls).toBe(4);
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

  test("a decision's own usage cannot reject the event it chose", async () => {
    const schemas = createAgentSchemas({
      context: z.object({ left: z.number() }),
      output: z.object({ left: z.number() }),
      events: { GO: z.object({}) },
    });
    const machine = setupAgent({ schemas }).createMachine({
      context: () => ({ left: 1 }),
      on: {
        [AGENT_USAGE_EVENT_TYPE]: ({ event }) => ({
          context: { left: event.budget!.maxModelCalls - event.budget!.modelCalls },
        }),
      },
      initial: "deciding",
      states: {
        deciding: {
          invoke: {
            id: "choose",
            src: "agent.decide",
            input: { model: "test-model", prompt: "pick", allowedEvents: ["GO"] as const },
          },
          // Spending the last call is allowed; it was not spent when GO was chosen.
          on: { GO: ({ context }) => (context.left > 0 ? { target: "chosen" } : undefined) },
        },
        chosen: {},
      },
    });

    const trace: AgentTraceEvent[] = [];
    const result = await runToQuiescence(
      createAgentRuntime(machine, {
        maxModelCalls: 1,
        executors: {
          decide: async () => ({ event: { type: "GO" } as ChosenEvent, usage: { totalTokens: 1 } }),
        },
        onTrace: (event) => trace.push(event),
      }),
    );

    expect(result.status).toBe("idle");
    expect(result.snapshot.value).toBe("chosen");
    expect(result.snapshot.context).toEqual({ left: 0 });
    // The decision names the step it chose, not the usage step that followed.
    const steps = traceSteps(trace).filter((step) => !step.ignored);
    expect(steps.map((step) => [step.event, step.decision])).toEqual([
      ["GO", "choose"],
      [AGENT_USAGE_EVENT_TYPE, undefined],
    ]);
  });
});
