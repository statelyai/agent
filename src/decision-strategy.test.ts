import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  createDecisionLogic,
  createDecisionRequest,
  resolveDecision,
  type AgentDecisionExecutor,
  type AgentExecutorDecisionRequest,
} from "./decision.js";
import {
  decisionGroups,
  enumerateFinitePayloads,
  resolveDecisionStrategy,
} from "./decision-strategy.js";
import { createInMemoryEventLogStore } from "./event-log-store.js";
import { createAgentRuntime, runToQuiescence } from "./run-agent.js";
import { createAgentSchemas, setupAgent } from "./setup-agent.js";
import type { AgentRequestExecutor, AgentRequestExecutorInfo } from "./text-logic.js";
import type { AgentTraceEvent, ChosenEvent } from "./index.js";
import { sanitizeEventToolName } from "./events.js";

const schemas = {
  "desk.refund": z.object({ amount: z.number(), note: z.string() }),
  "desk.tag": z.object({ priority: z.enum(["low", "high"]), urgent: z.boolean() }),
  "desk.close": z.object({}),
};
const events = Object.entries(schemas).map(([type, inputSchema]) => ({
  type,
  toolName: sanitizeEventToolName(type),
  inputSchema,
}));

interface Call {
  kind: "decide" | "fill";
  request: AgentExecutorDecisionRequest | Parameters<AgentRequestExecutor>[0];
  info?: AgentRequestExecutorInfo;
}

// Like a decision model: answers closed choices only, by option index.
function closedChoiceDecide(calls: Call[], answers: string[]): AgentDecisionExecutor {
  return async (request, info) => {
    calls.push({ kind: "decide", request, info });
    if (!request.options) throw new Error("closed choices only");
    const answer = answers.shift()!;
    const option = request.options.find(
      (candidate) =>
        candidate.event.type === answer || JSON.stringify(candidate.event).includes(answer),
    );
    return option
      ? { event: option.event }
      : { rejected: { failure: "unknown-event", reason: `no option '${answer}'` } };
  };
}

function fillText(calls: Call[], results: unknown[]): AgentRequestExecutor {
  return async (request, info) => {
    calls.push({ kind: "fill", request, info });
    return { result: results.shift() };
  };
}

describe("decide strategies", () => {
  test("pick-then-fill picks the type by closed choice, then fills it with fillModel", async () => {
    const calls: Call[] = [];
    const event = await resolveDecision(
      createDecisionRequest({
        name: "triage",
        model: "picker",
        prompt: "Handle the ticket.",
        events,
        fillModel: "writer",
      }),
      {
        decide: closedChoiceDecide(calls, ["desk.refund"]),
        generateText: fillText(calls, [{ amount: 20, note: "late" }]),
      },
    );
    expect(event).toEqual({ type: "desk.refund", amount: 20, note: "late" });
    const [pick, fill] = calls;
    expect((pick!.request as AgentExecutorDecisionRequest).options).toEqual([
      { event: { type: "desk.refund" } },
      { event: { type: "desk.tag" } },
      { event: { type: "desk.close" } },
    ]);
    expect(fill!.request).toMatchObject({
      model: "writer",
      outputSchema: schemas["desk.refund"],
      prompt: "Handle the ticket.\n\nYou chose 'desk.refund'. Write its payload.",
    });
  });

  test("a finite payload is filled by a second closed choice with the same model", async () => {
    const calls: Call[] = [];
    const event = await resolveDecision(
      createDecisionRequest({ model: "picker", events, strategy: "pick-then-fill" }),
      { decide: closedChoiceDecide(calls, ["desk.tag", '"high","urgent":true']) },
    );
    expect(event).toEqual({ type: "desk.tag", priority: "high", urgent: true });
    expect(calls.map((call) => call.request.model)).toEqual(["picker", "picker"]);
    expect((calls[1]!.request as AgentExecutorDecisionRequest).options).toHaveLength(4);
  });

  test("an empty payload needs no fill call", async () => {
    const calls: Call[] = [];
    const event = await resolveDecision(
      createDecisionRequest({ model: "picker", events, strategy: "pick-then-fill" }),
      { decide: closedChoiceDecide(calls, ["desk.close"]) },
    );
    expect(event).toEqual({ type: "desk.close" });
    expect(calls).toHaveLength(1);
  });

  test("an open payload without fillModel is a clear error", async () => {
    await expect(
      resolveDecision(
        createDecisionRequest({ model: "picker", events, strategy: "pick-then-fill" }),
        { decide: closedChoiceDecide([], ["desk.refund"]) },
      ),
    ).rejects.toMatchObject({ code: "missing-fill-model" });
  });

  test("grouped picks a prefix group, then decides within it", async () => {
    const calls: Call[] = [];
    const event = await resolveDecision(
      createDecisionRequest({
        model: "picker",
        events: ["desk.close", "desk.open", "ops.page"],
        strategy: "grouped",
      }),
      {
        decide: async (request, info) => {
          calls.push({ kind: "decide", request, info });
          return { event: { type: calls.length === 1 ? "desk" : "desk.open" } };
        },
      },
    );
    expect(event).toEqual({ type: "desk.open" });
    const [group, pick] = calls.map((call) => call.request as AgentExecutorDecisionRequest);
    expect(group!.options).toEqual([
      { event: { type: "desk" }, description: "One of: desk.close, desk.open" },
      { event: { type: "ops" }, description: "One of: ops.page" },
    ]);
    expect(pick!.events.map((candidate) => candidate.type)).toEqual(["desk.close", "desk.open"]);
  });

  test("explicit groups win; the rest group by prefix", () => {
    expect(
      decisionGroups({
        events: ["a.x", "a.y", "b.z"].map((type) => ({ type, toolName: type })),
        groups: { mixed: ["a.x", "b.z", "missing"] },
      }),
    ).toEqual([
      { name: "mixed", types: ["a.x", "b.z"] },
      { name: "a", types: ["a.y"] },
    ]);
  });

  test("auto: fillModel → pick-then-fill; many events in groups → grouped; else direct", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      type: `${i % 2 ? "a" : "b"}.${i}`,
      toolName: `e${i}`,
    }));
    expect(resolveDecisionStrategy({ events, fillModel: "writer" })).toBe("pick-then-fill");
    expect(resolveDecisionStrategy({ events: many })).toBe("grouped");
    expect(resolveDecisionStrategy({ events: many.slice(0, 24) })).toBe("direct");
    expect(resolveDecisionStrategy({ events })).toBe("direct");
    expect(resolveDecisionStrategy({ events: many, strategy: "direct" })).toBe("direct");
  });

  test("finite payloads enumerate required finite fields, capped at 32", () => {
    expect(
      enumerateFinitePayloads({
        type: "object",
        properties: { on: { type: "boolean" }, size: { anyOf: [{ const: 1 }, { const: 2 }] } },
        required: ["on", "size"],
      }),
    ).toEqual([
      { on: true, size: 1 },
      { on: true, size: 2 },
      { on: false, size: 1 },
      { on: false, size: 2 },
    ]);
    const wide = { enum: Array.from({ length: 6 }, (_, i) => i) };
    expect(
      enumerateFinitePayloads({ properties: { a: wide, b: wide }, required: ["a", "b"] }),
    ).toBeUndefined();
    expect(
      enumerateFinitePayloads({ properties: { a: { type: "string" } }, required: [] }),
    ).toBeUndefined();
  });

  test("finite root unions enumerate every object variant", () => {
    expect(
      enumerateFinitePayloads({
        anyOf: [
          {
            type: "object",
            properties: { method: { const: "ground" }, days: { const: 5 } },
            required: ["method", "days"],
          },
          {
            type: "object",
            properties: { method: { const: "air" }, cabin: { enum: ["coach", "first"] } },
            required: ["method", "cabin"],
          },
        ],
      }),
    ).toEqual([
      { method: "ground", days: 5 },
      { method: "air", cabin: "coach" },
      { method: "air", cabin: "first" },
    ]);
    expect(
      enumerateFinitePayloads({
        anyOf: [
          { type: "object", properties: { kind: { const: "known" } }, required: ["kind"] },
          { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
        ],
      }),
    ).toBeUndefined();
  });

  test("attempts feedback reaches every sub-call", async () => {
    const calls: Call[] = [];
    const answers = ["desk.refund", "desk.refund"];
    await resolveDecision(createDecisionRequest({ model: "picker", events, fillModel: "writer" }), {
      decide: closedChoiceDecide(calls, answers),
      // The first fill misses `note`; the retry carries that failure.
      generateText: fillText(calls, [{ amount: 1 }, { amount: 1, note: "ok" }]),
    });
    const attemptCounts = calls.map((call) =>
      call.kind === "decide"
        ? (call.request as AgentExecutorDecisionRequest).attempts.length
        : String(call.request.prompt).includes("previous choice failed")
          ? 1
          : 0,
    );
    expect(attemptCounts).toEqual([0, 0, 1, 1]);
  });

  test("direct makes one decide call with the request unchanged", async () => {
    const seen: AgentExecutorDecisionRequest[] = [];
    const request = createDecisionRequest({ model: "picker", events, strategy: "direct" });
    await resolveDecision(request, {
      decide: async (attempt) => (seen.push(attempt), { event: { type: "desk.close" } }),
    });
    expect(seen).toEqual([{ ...request, name: "decision", attempts: [] }]);
  });
});

describe("decide strategies in the runtime", () => {
  function createDeskMachine(input: Record<string, unknown>) {
    const machineSchemas = createAgentSchemas({ context: z.object({}), events: schemas });
    return setupAgent({ schemas: machineSchemas }).createMachine({
      context: {},
      initial: "deciding",
      states: {
        deciding: {
          invoke: {
            id: "triage",
            src: "agent.decide",
            input: {
              model: "picker",
              prompt: "Handle the ticket.",
              allowedEvents: ["desk.refund", "desk.tag", "desk.close"] as const,
              ...input,
            },
            onError: { target: "failed" },
          },
          on: { "desk.refund": { target: "done" }, "desk.close": { target: "done" } },
        },
        done: {},
        failed: {},
      },
    });
  }

  test("sub-calls are keyed .pick/.fill, budgeted, traced, and usage-recorded", async () => {
    const calls: Call[] = [];
    const trace: AgentTraceEvent[] = [];
    const result = await runToQuiescence(
      createAgentRuntime(createDeskMachine({ fillModel: "writer" }), {
        store: createInMemoryEventLogStore(),
        threadId: "t",
        maxModelCalls: 2,
        executors: {
          decide: async (request, info) => {
            calls.push({ kind: "decide", request, info });
            return { event: { type: "desk.refund" } as ChosenEvent, usage: { totalTokens: 3 } };
          },
          generateText: async (request, info) => {
            calls.push({ kind: "fill", request, info });
            return { result: { amount: 5, note: "ok" }, usage: { totalTokens: 7 } };
          },
        },
        onTrace: (event) => trace.push(event),
      }),
    );
    expect(result.snapshot.value).toBe("done");
    expect(calls.map((call) => call.info?.callKey?.split(":")[1])).toEqual([
      "triage#1.0.pick",
      "triage#1.0.fill",
    ]);
    expect(trace.filter((event) => event.type === "request.start")).toHaveLength(2);
    expect(trace.filter((event) => event.type === "request.end")).toHaveLength(2);
    expect(result.usage).toMatchObject({ modelCalls: 2, totalTokens: 10 });
  });

  test("the fill sub-call counts against the model-call budget", async () => {
    const result = await runToQuiescence(
      createAgentRuntime(createDeskMachine({ fillModel: "writer" }), {
        maxModelCalls: 1,
        executors: {
          decide: async () => ({ event: { type: "desk.refund" } as ChosenEvent }),
          generateText: async () => ({ result: { amount: 5, note: "ok" } }),
        },
      }),
    );
    expect(result.snapshot.value).toBe("failed");
  });

  test("the fill sub-call records every provider model call", async () => {
    const result = await runToQuiescence(
      createAgentRuntime(createDeskMachine({ fillModel: "writer" }), {
        maxModelCalls: 4,
        executors: {
          decide: async () => ({ event: { type: "desk.refund" } as ChosenEvent }),
          generateText: async () => ({
            result: { amount: 5, note: "ok" },
            modelCalls: 3,
          }),
        },
      }),
    );
    expect(result.snapshot.value).toBe("done");
    expect(result.usage.modelCalls).toBe(4);
  });

  test("a failed fill records every provider model call", async () => {
    const result = await runToQuiescence(
      createAgentRuntime(createDeskMachine({ fillModel: "writer" }), {
        maxModelCalls: 4,
        executors: {
          decide: async () => ({ event: { type: "desk.refund" } as ChosenEvent }),
          generateText: async () => {
            throw Object.assign(new Error("bad fill"), { modelCalls: 3 });
          },
        },
      }),
    );
    expect(result.snapshot.value).toBe("failed");
    expect(result.usage.modelCalls).toBe(4);
  });

  test("a runtime pick-then-fill over an open payload without fillModel errors", async () => {
    const result = await runToQuiescence(
      createAgentRuntime(createDeskMachine({ strategy: "pick-then-fill" }), {
        executors: { decide: async () => ({ event: { type: "desk.refund" } as ChosenEvent }) },
      }),
    );
    expect(result.snapshot.value).toBe("failed");
  });

  test("direct keeps one call and the attempt key", async () => {
    const keys: Array<string | undefined> = [];
    await runToQuiescence(
      createAgentRuntime(createDeskMachine({}), {
        store: createInMemoryEventLogStore(),
        threadId: "t",
        executors: {
          decide: async (_request, info) => {
            keys.push(info?.callKey?.split(":")[1]);
            return { event: { type: "desk.close" } as ChosenEvent };
          },
        },
      }),
    );
    expect(keys).toEqual(["triage#1.0"]);
  });
});

test("agent.decide types strategy, fillModel, and groups against the machine's events", () => {
  const machineSchemas = createAgentSchemas({ context: z.object({}), events: schemas });
  setupAgent({ schemas: machineSchemas }).createMachine({
    context: {},
    initial: "deciding",
    states: {
      deciding: {
        // @ts-expect-error `desk.nope` is not one of the machine's event types
        invoke: {
          src: "agent.decide",
          input: {
            model: "picker",
            allowedEvents: ["desk.refund", "desk.close"] as const,
            strategy: "grouped",
            fillModel: "writer",
            groups: {
              money: ["desk.refund"],
              other: ["desk.nope"],
            },
          },
        },
      },
    },
  });
});

test("createDecisionLogic carries strategy, fillModel, and groups onto its request", () => {
  const logic = createDecisionLogic({
    model: "m",
    allowedEvents: ["cart.add", "cart.clear"],
    strategy: "grouped",
    fillModel: "filler",
    groups: { cart: ["cart.add", "cart.clear"] },
  });
  expect(logic.request({} as never)).toMatchObject({
    strategy: "grouped",
    fillModel: "filler",
    groups: { cart: ["cart.add", "cart.clear"] },
  });
});
