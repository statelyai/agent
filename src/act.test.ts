import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createActor, toPromise } from "xstate";
import { ACT_STATE_EXITED } from "./act.js";
import { createInMemoryEventLogStore } from "./log/index.js";
import { provideExecutors } from "./provide-executors.js";
import { createAgentRuntime, runToQuiescence, type AgentTraceEvent } from "./run-agent.js";
import { createAgentSchemas, setupAgent } from "./setup-agent.js";
import type { AgentExecutorTextRequest, AgentRequestExecutorInfo } from "./text-logic.js";
import type { AgentToolDescriptor } from "./types.js";

const schemas = createAgentSchemas({
  context: z.object({ items: z.array(z.string()), note: z.string() }),
  input: z.object({}),
  events: {
    ADD: z.object({ item: z.string() }),
    CHECKOUT: z.object({}),
    APPROVE: z.object({}),
  },
});

// Shopping takes ADD freely; CHECKOUT only with something in the cart; a
// person sends APPROVE. `onDone` keeps the act's final text.
function cartMachine(input: Record<string, unknown> = {}) {
  return setupAgent({ schemas }).createMachine({
    id: "cart",
    context: { items: [], note: "" },
    initial: "shopping",
    states: {
      shopping: {
        invoke: {
          src: "agent.act",
          input: { model: "m", prompt: "Shop.", ...input },
          onDone: ({ context, event }) => ({
            target: "idle",
            context: { ...context, note: String(event.output) },
          }),
        },
        on: {
          ADD: ({ context, event }) => ({
            context: { ...context, items: [...context.items, event.item] },
          }),
          CHECKOUT: ({ context }) => (context.items.length > 0 ? { target: "paid" } : undefined),
          APPROVE: { target: "paid", meta: { actor: "human" } },
        },
      },
      idle: {},
      paid: { type: "final" },
    },
  });
}

type Call = (name: string, args?: unknown) => Promise<unknown>;

// A generateText mock that runs `script` against the request's tools.
function scripted(
  script: (
    call: Call,
    request: AgentExecutorTextRequest,
    info?: AgentRequestExecutorInfo,
  ) => Promise<unknown>,
  extra: Record<string, unknown> = {},
) {
  const requests: AgentExecutorTextRequest[] = [];
  // Settles when the script ends.
  let ended!: () => void;
  const done = new Promise<void>((resolve) => (ended = resolve));
  const generateText = async (
    request: AgentExecutorTextRequest,
    info?: AgentRequestExecutorInfo,
  ) => {
    requests.push(request);
    const call: Call = async (name, args) => {
      const tool = request.tools?.[name] as AgentToolDescriptor | undefined;
      if (!tool?.execute) throw new Error(`no tool ${name}`);
      return tool.execute(args);
    };
    try {
      const result = await script(call, request, info);
      return { result: result ?? "done", ...extra };
    } finally {
      ended();
    }
  };
  return { generateText, requests, done };
}

describe("agent.act", () => {
  test("delivers several events from one step in call order and answers each with its delta", async () => {
    const results: unknown[] = [];
    const { generateText } = scripted(async (call) => {
      // One step's parallel calls: serialized in call order.
      results.push(
        ...(await Promise.all([
          call("send_event_ADD", { item: "apple" }),
          call("send_event_ADD", { item: "pear" }),
        ])),
      );
      results.push(await call("send_event_CHECKOUT", {}));
      return undefined;
    });
    const result = await runToQuiescence(
      createAgentRuntime(cartMachine(), { executors: { generateText } }),
      { input: {} },
    );

    expect(result.status).toBe("done");
    expect(results).toEqual([
      { changed: { items: ["apple"] } },
      { changed: { items: ["apple", "pear"] } },
      { state: "paid" },
    ]);
    expect(
      result.events.map((entry) => entry.event.type).filter((type) => !type.startsWith("@agent")),
    ).toEqual(["ADD", "ADD", "CHECKOUT"]);
  });

  test("a disallowed event gets an error result and is not sent", async () => {
    const results: unknown[] = [];
    const { generateText } = scripted(async (call) => {
      results.push(await call("send_event_CHECKOUT", {}));
      return "gave up";
    });
    const result = await runToQuiescence(
      createAgentRuntime(cartMachine(), { executors: { generateText } }),
      { input: {} },
    );

    expect(results).toEqual([`'CHECKOUT' is not allowed in state "shopping"`]);
    expect(result.events.some((entry) => entry.event.type === "CHECKOUT")).toBe(false);
    // The state stayed: `onDone` saw the final text.
    expect(result.snapshot.value).toBe("idle");
    expect(result.snapshot.context.note).toBe("gave up");
  });

  test("an invalid payload gets an error result", async () => {
    const results: unknown[] = [];
    const { generateText } = scripted(async (call) => {
      results.push(await call("send_event_ADD", { item: 5 }));
      return undefined;
    });
    const result = await runToQuiescence(
      createAgentRuntime(cartMachine(), { executors: { generateText } }),
      { input: {} },
    );

    expect(results[0]).toMatch(/^'ADD' payload failed validation/);
    expect(result.snapshot.context.items).toEqual([]);
  });

  test("leaving the state stops the loop: later calls answer 'state exited'", async () => {
    const results: unknown[] = [];
    let aborted: boolean | undefined;
    const { generateText, done } = scripted(async (call, _request, info) => {
      results.push(await call("send_event_ADD", { item: "apple" }));
      results.push(await call("send_event_CHECKOUT", {}));
      aborted = info?.signal?.aborted;
      results.push(await call("send_event_ADD", { item: "late" }));
      return undefined;
    });
    const result = await runToQuiescence(
      createAgentRuntime(cartMachine(), { executors: { generateText } }),
      { input: {} },
    );
    await done;

    expect(result.status).toBe("done");
    expect(aborted).toBe(true);
    expect(results.slice(1)).toEqual([{ state: "paid" }, ACT_STATE_EXITED]);
    expect(result.snapshot.context.items).toEqual(["apple"]);
  });

  test("offers accepted non-human events as tools beside plain tools", async () => {
    let looked: unknown;
    const { generateText, requests } = scripted(async (call) => {
      looked = await call("lookup", { sku: 1 });
      return undefined;
    });
    await runToQuiescence(
      createAgentRuntime(
        cartMachine({
          tools: { lookup: { description: "Find a product.", execute: () => "pear" } },
        }),
        { executors: { generateText } },
      ),
      { input: {} },
    );

    expect(Object.keys(requests[0]!.tools ?? {}).sort()).toEqual([
      "lookup",
      "send_event_ADD",
      "send_event_CHECKOUT",
    ]);
    expect(looked).toBe("pear");
    expect(requests[0]!.maxSteps).toBe(20);
  });

  test("allowedEvents narrows the event tools", async () => {
    const { generateText, requests } = scripted(async () => undefined);
    await runToQuiescence(
      createAgentRuntime(cartMachine({ allowedEvents: ["ADD"], maxSteps: 3 }), {
        executors: { generateText },
      }),
      { input: {} },
    );
    expect(Object.keys(requests[0]!.tools ?? {})).toEqual(["send_event_ADD"]);
    expect(requests[0]!.maxSteps).toBe(3);
  });

  test("counts against the budget, traces, and records usage like a text request", async () => {
    const traces: AgentTraceEvent[] = [];
    const { generateText } = scripted(async () => "ok", {
      modelCalls: 3,
      usage: { inputTokens: 5 },
    });
    const result = await runToQuiescence(
      createAgentRuntime(cartMachine(), {
        executors: { generateText },
        onTrace: (event) => traces.push(event),
      }),
      { input: {} },
    );

    expect(result.usage.modelCalls).toBe(3);
    expect(result.usage.inputTokens).toBe(5);
    const start = traces.find((event) => event.type === "request.start") as
      | (AgentTraceEvent & { request: { kind: string; src: string } })
      | undefined;
    expect(start?.request).toMatchObject({ kind: "text", src: "agent.act" });
    expect(traces.some((event) => event.type === "request.end")).toBe(true);
  });

  test("a maxModelCalls budget stops an act before its call", async () => {
    const { generateText, requests } = scripted(async () => "ok");
    const result = await runToQuiescence(
      createAgentRuntime(cartMachine(), { executors: { generateText }, maxModelCalls: 0 }),
      { input: {} },
    );
    expect(requests).toHaveLength(0);
    expect(result.status).toBe("error");
  });

  test("the store journals act-sent events in delivery order", async () => {
    const store = createInMemoryEventLogStore();
    const { generateText } = scripted(async (call) => {
      await call("send_event_ADD", { item: "a" });
      await call("send_event_ADD", { item: "b" });
      await call("send_event_CHECKOUT", {});
      return undefined;
    });
    await runToQuiescence(
      createAgentRuntime(cartMachine(), { store, threadId: "cart-1", executors: { generateText } }),
      { input: {} },
    );
    const stored = await store.read("cart-1");
    expect(
      stored
        .map((entry) => entry.event)
        .filter((event) => ["ADD", "CHECKOUT"].includes(event.type)),
    ).toEqual([{ type: "ADD", item: "a" }, { type: "ADD", item: "b" }, { type: "CHECKOUT" }]);
  });

  test("runs under provideExecutors", async () => {
    const results: unknown[] = [];
    const { generateText, done } = scripted(async (call) => {
      results.push(await call("send_event_ADD", { item: "apple" }));
      results.push(await call("send_event_CHECKOUT", {}));
      results.push(await call("send_event_ADD", { item: "late" }));
      return undefined;
    });
    const actor = createActor(provideExecutors(cartMachine(), { generateText }), { input: {} });
    actor.start();
    await toPromise(actor);
    await done;

    expect(actor.getSnapshot().context.items).toEqual(["apple"]);
    expect(results).toEqual([
      { changed: { items: ["apple"] } },
      { state: "paid" },
      ACT_STATE_EXITED,
    ]);
  });

  test("offers every event the invoking state and its descendants accept, from the start", async () => {
    const ticketSchemas = createAgentSchemas({
      context: z.object({}),
      input: z.object({}),
      events: {
        LABEL: z.object({}),
        ASSIGN: z.object({}),
        APPROVE: z.object({}),
        CANCEL: z.object({}),
      },
    });
    // ASSIGN is accepted only once LABEL has moved T1 on; APPROVE only by a person.
    const machine = setupAgent({ schemas: ticketSchemas }).createMachine({
      context: {},
      initial: "work",
      on: { CANCEL: { target: ".cancelled" } },
      states: {
        work: {
          type: "parallel",
          invoke: { src: "agent.act", input: { model: "m", prompt: "Triage." } },
          onDone: { target: "triaged" },
          states: {
            T1: {
              initial: "open",
              states: {
                open: { on: { LABEL: { target: "labeled" } } },
                labeled: {
                  on: {
                    ASSIGN: { target: "assigned" },
                    APPROVE: { target: "assigned", meta: { actor: "human" } },
                  },
                },
                assigned: { type: "final" },
              },
            },
          },
        },
        triaged: { type: "final" },
        cancelled: { type: "final" },
      },
    });
    const results: unknown[] = [];
    const { generateText, requests } = scripted(async (call) => {
      results.push(await call("send_event_ASSIGN", {}));
      results.push(await call("send_event_LABEL", {}));
      results.push(await call("send_event_ASSIGN", {}));
      return undefined;
    });
    const result = await runToQuiescence(
      createAgentRuntime(machine, { executors: { generateText } }),
      { input: {} },
    );

    expect(Object.keys(requests[0]!.tools ?? {}).sort()).toEqual([
      "send_event_ASSIGN",
      "send_event_CANCEL",
      "send_event_LABEL",
    ]);
    // Not accepted yet: refused, not sent.
    expect(results[0]).toBe(`'ASSIGN' is not allowed in state {"work":{"T1":"open"}}`);
    expect(results.slice(1)).toEqual([
      { state: { work: { T1: "labeled" } } },
      { state: "triaged" },
    ]);
    expect(result.status).toBe("done");
    expect(result.snapshot.value).toBe("triaged");
  });

  test.each([
    ["returns", false],
    ["rejects", true],
  ])(
    "usage counts every request of a loop a state exit ends (the executor %s)",
    async (_label, rejects) => {
      const spent = { modelCalls: 3, usage: { inputTokens: 6, outputTokens: 3, totalTokens: 9 } };
      const { generateText } = scripted(async (call) => {
        await call("send_event_ADD", { item: "apple" });
        await call("send_event_CHECKOUT", {});
        // The host's tool loop settles a while after the exit aborted it.
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (rejects) throw Object.assign(new Error("aborted"), spent);
        return undefined;
      }, spent);
      const result = await runToQuiescence(
        createAgentRuntime(cartMachine(), { executors: { generateText } }),
        { input: {} },
      );

      expect(result.status).toBe("done");
      expect(result.usage).toEqual({
        modelCalls: 3,
        inputTokens: 6,
        outputTokens: 3,
        totalTokens: 9,
      });
    },
  );

  test("a stop ends the wait for an act loop a state exit aborted", async () => {
    const { generateText } = scripted(async (call) => {
      await call("send_event_ADD", { item: "apple" });
      await call("send_event_CHECKOUT", {});
      // The host's tool loop never settles after the exit aborted it.
      return new Promise<undefined>(() => {});
    });
    const controller = new AbortController();
    const reason = new Error("host stopped");
    setTimeout(() => controller.abort(reason), 20);
    const result = await runToQuiescence(
      createAgentRuntime(cartMachine(), { executors: { generateText }, signal: controller.signal }),
      { input: {} },
    );

    expect(result).toMatchObject({ status: "error", error: reason });
  }, 2000);

  test("allowedEvents is typed against the machine's events", () => {
    setupAgent({ schemas }).createMachine({
      context: { items: [], note: "" },
      initial: "a",
      states: {
        a: {
          // @ts-expect-error NOPE is not a declared event
          invoke: {
            src: "agent.act",
            input: { model: "m", prompt: "Go.", allowedEvents: ["NOPE"] },
          },
        },
      },
    });
  });
});
