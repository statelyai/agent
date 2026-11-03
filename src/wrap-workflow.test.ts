import { describe, expect, expectTypeOf, test } from "vitest";
import { describeMachine, runAgent, wrapWorkflow, type AgentTraceEvent } from "./index.js";
import { canReach, createRecorder, RecordingDivergenceError } from "./testing/index.js";

interface Ticket {
  orderId: string;
  amount: number;
}

function createEffects() {
  const refunds: Ticket[] = [];
  return {
    refunds,
    effects: {
      lookupOrder: async (orderId: string) => ({ orderId, total: 50 }),
      issueRefund: async (refund: Ticket) => {
        refunds.push(refund);
        return { refundId: `R-${refund.orderId}` };
      },
    },
  };
}

type Effects = ReturnType<typeof createEffects>["effects"];

async function legacy(ticket: Ticket, effects: Effects) {
  const order = await effects.lookupOrder(ticket.orderId);
  if (ticket.amount > order.total) return { outcome: "declined" as const };
  const { refundId } = await effects.issueRefund(ticket);
  return { outcome: "refunded" as const, refundId };
}

const ticket: Ticket = { orderId: "A-1", amount: 20 };

describe("wrapWorkflow", () => {
  test("returns what the workflow returned, with types from the callback", async () => {
    const { effects, refunds } = createEffects();
    const support = wrapWorkflow({
      id: "support",
      effects,
      run: (input: Ticket, fx) => {
        expectTypeOf(fx).toEqualTypeOf<Effects>();
        return legacy(input, fx);
      },
    });
    const result = await support.run(ticket);
    expectTypeOf(result).toEqualTypeOf<Awaited<ReturnType<typeof legacy>>>();
    expect(result).toEqual(await legacy(ticket, createEffects().effects));
    expect(refunds).toEqual([ticket]);
  });

  test("rethrows the original error object", async () => {
    const boom = new TypeError("lookup down");
    const support = wrapWorkflow({
      id: "support",
      effects: {
        lookupOrder: async (_orderId: string): Promise<{ total: number }> => {
          throw boom;
        },
      },
      run: async (input: Ticket, fx) => (await fx.lookupOrder(input.orderId)).total,
    });
    await expect(support.run(ticket)).rejects.toBe(boom);
  });

  test("each effect call is a transition", async () => {
    const support = wrapWorkflow({ id: "support", effects: createEffects().effects, run: legacy });
    const events: Array<{ type: string; calls: number }> = [];
    await support.run(ticket, {
      onTransition: (snapshot, event) =>
        events.push({ type: event.type, calls: snapshot.context.calls }),
    });
    expect(events.slice(0, -1)).toEqual([
      { type: "@xstate.init", calls: 0 },
      { type: "effect.call", calls: 1 },
      { type: "effect.done", calls: 1 },
      { type: "effect.call", calls: 2 },
      { type: "effect.done", calls: 2 },
    ]);
    expect(events.at(-1)?.type).toMatch(/^xstate\.done\.actor/);
  });

  test("effect events carry JSON-safe names, args and results, and land in the log and traces", async () => {
    const support = wrapWorkflow({ id: "support", effects: createEffects().effects, run: legacy });
    const traces: AgentTraceEvent[] = [];
    const entries: unknown[] = [];
    await support.run(ticket, {
      onTrace: (event) => traces.push(event),
      onEvent: (entry) => entries.push(entry.event),
    });
    const effectEvents = entries.filter((event) =>
      (event as { type: string }).type.startsWith("effect."),
    );
    expect(effectEvents).toEqual([
      { type: "effect.call", name: "lookupOrder", call: 0, args: ["A-1"] },
      { type: "effect.done", name: "lookupOrder", call: 0, result: { orderId: "A-1", total: 50 } },
      { type: "effect.call", name: "issueRefund", call: 1, args: [ticket] },
      { type: "effect.done", name: "issueRefund", call: 1, result: { refundId: "R-A-1" } },
    ]);
    expect(
      traces
        .filter((t) => t.type === "machine.transition")
        .map((t) => (t as { event: { type: string } }).event.type),
    ).toContain("effect.done");
  });

  test("a failed effect is an effect.error event", async () => {
    const support = wrapWorkflow({
      id: "support",
      effects: {
        flaky: async (): Promise<string> => {
          throw new Error("503");
        },
      },
      run: async (_input: null, fx) => fx.flaky().catch(() => "fallback"),
    });
    const seen: unknown[] = [];
    const result = await support.run(null, {
      onTransition: (snapshot, event) => {
        if (event.type === "effect.error") seen.push([event.error, snapshot.context.failures]);
      },
    });
    expect(result).toBe("fallback");
    expect(seen).toEqual([[expect.objectContaining({ name: "Error", message: "503" }), 1]]);
  });

  test("effects can be overridden for one run", async () => {
    const { effects, refunds } = createEffects();
    const support = wrapWorkflow({ id: "support", effects, run: legacy });
    const result = await support.run(ticket, {
      effects: { lookupOrder: async (orderId: string) => ({ orderId, total: 5 }) },
    });
    expect(result).toEqual({ outcome: "declined" });
    expect(refunds).toEqual([]);
  });

  test("a recorder records every effect and the output", async () => {
    const support = wrapWorkflow({ id: "support", effects: createEffects().effects, run: legacy });
    const recorder = createRecorder();
    await support.run(ticket, { recorder });
    expect(recorder.recording.effects).toEqual([
      {
        kind: "call",
        name: "lookupOrder",
        call: 0,
        args: ["A-1"],
        result: { orderId: "A-1", total: 50 },
      },
      { kind: "call", name: "issueRefund", call: 0, args: [ticket], result: { refundId: "R-A-1" } },
      { kind: "output", value: { outcome: "refunded", refundId: "R-A-1" } },
    ]);

    // The recording replays: no effect runs.
    const replay = createRecorder({ replay: recorder.recording });
    const { effects, refunds } = createEffects();
    await support.run(ticket, { effects, recorder: replay });
    expect(refunds).toEqual([]);
    await expect(
      support.run(
        { orderId: "A-1", amount: 20 },
        { recorder: createRecorder({ replay: { version: 1, effects: [] } }) },
      ),
    ).rejects.toBeInstanceOf(RecordingDivergenceError);
  });

  test("signal reaches the workflow, which decides what an abort returns", async () => {
    let workflowSignal: AbortSignal | undefined;
    const support = wrapWorkflow({
      id: "slow",
      effects: {},
      run: (_input: null, _fx, { signal }) =>
        new Promise<string>((resolve) => {
          workflowSignal = signal;
          signal.addEventListener("abort", () => resolve("too late"));
        }),
    });
    const controller = new AbortController();
    const reason = new Error("user cancelled");
    setTimeout(() => controller.abort(reason), 5);
    // The legacy behavior stands: this workflow resolves on abort.
    await expect(support.run(null, { signal: controller.signal })).resolves.toBe("too late");
    expect(workflowSignal?.aborted).toBe(true);
    expect(workflowSignal?.reason).toBe(reason);
  });

  test("the machine runs with runAgent, describeMachine and canReach", async () => {
    const support = wrapWorkflow({ id: "support", effects: createEffects().effects, run: legacy });
    const result = await runAgent(support.machine, { input: ticket });
    expect(result.status).toBe("done");
    if (result.status === "done") {
      expect(result.output).toEqual({ outcome: "refunded", refundId: "R-A-1" });
      expect(result.snapshot.context.calls).toBe(2);
    }
    expect(describeMachine(support.machine)).toContain("running");
    const reach = await canReach(support.machine, "done", {
      outputs: { workflow: [{ outcome: "declined" }] },
    });
    expect(reach.reachable).toBe(true);
  });

  test("a failure settles the run in error status", async () => {
    const boom = new Error("boom");
    const support = wrapWorkflow({
      id: "support",
      effects: {},
      run: async (): Promise<never> => {
        throw boom;
      },
    });
    const result = await runAgent(support.machine, { input: undefined });
    expect(result).toMatchObject({ status: "error", cause: "machine", error: boom });
  });
});

describe("wrapWorkflow: effects objects and safety", () => {
  class Store {
    constructor(private readonly prefix: string) {}
    async lookup(id: string) {
      return `${this.prefix}${id}`;
    }
  }

  test("a class instance's prototype methods are effects, bound to the instance", async () => {
    const wrapped = wrapWorkflow({
      id: "store",
      effects: new Store("order-"),
      run: async (id: string, effects) => effects.lookup(id),
    });
    const types: string[] = [];
    const out = await wrapped.run("7", {
      onTransition: (_s, event) => void types.push(event.type),
    });
    expect(out).toBe("order-7");
    expect(types).toContain("effect.call");
    const recorder = createRecorder();
    await wrapped.run("8", { recorder });
    expect(recorder.recording.effects.some((e) => e.kind === "call" && e.name === "lookup")).toBe(
      true,
    );
  });

  test("after an abort, effects throw instead of running", async () => {
    const controller = new AbortController();
    let calls = 0;
    const wrapped = wrapWorkflow({
      id: "retry",
      effects: {
        generate: async () => {
          calls++;
          if (calls === 1) controller.abort(new Error("stop"));
          throw new Error("overloaded");
        },
      },
      // Ignores its signal: retries until an effect stops it.
      run: async (_input: null, effects) => {
        for (let i = 0; i < 10; i++) {
          try {
            return await effects.generate();
          } catch (error) {
            if ((error as Error).message === "stop") throw error;
          }
        }
        return "gave up";
      },
    });
    await expect(wrapped.run(null, { signal: controller.signal })).rejects.toThrow("stop");
    expect(calls).toBe(1);
  });

  test("redact maps what the journal sees, not what the workflow gets", async () => {
    const seen: unknown[] = [];
    const wrapped = wrapWorkflow({
      id: "secret",
      effects: { login: async (token: string) => ({ token, user: "ada" }) },
      redact: (_name, part, value) =>
        part === "args"
          ? ["[redacted]"]
          : part === "result"
            ? { user: (value as { user: string }).user }
            : value,
      run: async (token: string, effects) => (await effects.login(token)).token,
    });
    const out = await wrapped.run("s3cret", {
      onTransition: (_s, event) => void seen.push(event),
    });
    expect(out).toBe("s3cret");
    const effectEvents = seen.filter((event) =>
      String((event as { type: string }).type).startsWith("effect."),
    );
    expect(effectEvents).toHaveLength(2);
    expect(JSON.stringify(effectEvents)).not.toContain("s3cret");
    expect(seen).toContainEqual(
      expect.objectContaining({ type: "effect.call", args: ["[redacted]"] }),
    );
  });
});
