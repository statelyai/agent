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

  test("a streaming effect is done after its chunks are consumed, with the chunks as result", async () => {
    const order: string[] = [];
    const wrapped = wrapWorkflow({
      id: "stream",
      effects: {
        tokens: async () =>
          (async function* () {
            yield "a";
            yield "b";
            yield "c";
          })(),
      },
      run: async (_input: null, fx) => {
        const stream = await fx.tokens();
        order.push("returned");
        let text = "";
        for await (const chunk of stream) text += chunk;
        order.push("consumed");
        return text;
      },
    });
    const events: Array<{ type: string; result?: unknown }> = [];
    const out = await wrapped.run(null, {
      onTransition: (_s, event) => {
        if (event.type === "effect.done") order.push("done");
        if (event.type.startsWith("effect.")) events.push(event as never);
      },
    });
    expect(out).toBe("abc");
    expect(events.find((e) => e.type === "effect.done")?.result).toEqual(["a", "b", "c"]);
    expect(order.indexOf("done")).toBeGreaterThan(order.indexOf("returned"));
  });

  test("a streaming effect that stops early is done with the chunks read so far", async () => {
    const wrapped = wrapWorkflow({
      id: "stream",
      effects: {
        tokens: async () =>
          (async function* () {
            yield 1;
            yield 2;
            yield 3;
          })(),
      },
      run: async (_input: null, fx) => {
        for await (const chunk of await fx.tokens()) return chunk;
        return 0;
      },
    });
    const done: unknown[] = [];
    const out = await wrapped.run(null, {
      onTransition: (_s, event) => {
        if (event.type === "effect.done") done.push(event.result);
      },
    });
    expect(out).toBe(1);
    expect(done).toEqual([[1]]);
  });

  test("a stream whose cleanup throws when stopped early is an effect.error", async () => {
    const closeFailed = new Error("close failed");
    const wrapped = wrapWorkflow({
      id: "stream",
      effects: {
        tokens: async () =>
          (async function* () {
            try {
              yield 1;
              yield 2;
            } finally {
              // oxlint-disable-next-line no-unsafe-finally
              throw closeFailed;
            }
          })(),
      },
      run: async (_input: null, fx) => {
        try {
          for await (const chunk of await fx.tokens()) return chunk;
        } catch (error) {
          return (error as Error).message;
        }
        return 0;
      },
    });
    const events: { type: string; result?: unknown; error?: unknown }[] = [];
    const out = await wrapped.run(null, {
      onTransition: (_s, event) => {
        if (event.type === "effect.done" || event.type === "effect.error") events.push(event);
      },
    });
    expect(out).toBe("close failed");
    expect(events.map((event) => event.type)).toEqual(["effect.error"]);
  });

  test("a Buffer input reaches the workflow as a Buffer", async () => {
    const wrapped = wrapWorkflow({
      id: "buffer",
      effects: {},
      run: async (input: { data: Buffer }) => input.data.toString("hex"),
    });
    expect(await wrapped.run({ data: Buffer.from("hi") })).toBe("6869");
  });

  test("for await reads the iterator a stream supplies, not its own next()", async () => {
    const supplied = (async function* () {
      yield "from iterator";
    })();
    const stream = {
      next: async () => ({ done: false, value: "from next" }),
      [Symbol.asyncIterator]: () => supplied,
    };
    const wrapped = wrapWorkflow({
      id: "stream",
      effects: { tokens: async () => stream },
      run: async (_input: null, fx) => {
        const seen: unknown[] = [];
        for await (const chunk of await fx.tokens()) seen.push(chunk);
        return seen;
      },
    });
    expect(await wrapped.run(null)).toEqual(["from iterator"]);
  });

  test("a stream that throws creating its iterator is an effect.error", async () => {
    const unavailable = new Error("unavailable");
    const wrapped = wrapWorkflow({
      id: "stream",
      effects: {
        tokens: async () => ({
          [Symbol.asyncIterator](): AsyncIterator<unknown> {
            throw unavailable;
          },
        }),
      },
      run: async (_input: null, fx) => {
        try {
          for await (const _chunk of await fx.tokens());
        } catch (error) {
          return (error as Error).message;
        }
        return "no error";
      },
    });
    const types: string[] = [];
    const out = await wrapped.run(null, {
      onTransition: (_s, event) => {
        if (event.type === "effect.done" || event.type === "effect.error") types.push(event.type);
      },
    });
    expect(out).toBe("unavailable");
    expect(types).toEqual(["effect.error"]);
  });

  test("a stream that throws mid-way is an effect.error, and the workflow sees the same error", async () => {
    const boom = new Error("stream broke");
    let caught: unknown;
    const wrapped = wrapWorkflow({
      id: "stream",
      effects: {
        tokens: async () =>
          (async function* () {
            yield "a";
            throw boom;
          })(),
      },
      run: async (_input: null, fx) => {
        try {
          for await (const _chunk of await fx.tokens());
        } catch (error) {
          caught = error;
        }
        return "handled";
      },
    });
    const seen: string[] = [];
    let error: unknown;
    await wrapped.run(null, {
      onTransition: (_s, event) => {
        if (event.type.startsWith("effect.")) seen.push(event.type);
        if (event.type === "effect.error") error = event.error;
      },
    });
    expect(caught).toBe(boom);
    expect(seen).toEqual(["effect.call", "effect.error"]);
    expect(error).toEqual(expect.objectContaining({ message: "stream broke" }));
  });

  test("a generator's return value reaches a manual next() loop and is recorded", async () => {
    const log = { prompt: "hi", tokens: 2 };
    const tokens = async () =>
      (async function* () {
        yield "a";
        yield "b";
        return log;
      })();
    const read = async (next: () => Promise<IteratorResult<string, typeof log>>) => {
      const chunks: string[] = [];
      for (let step = await next(); ; step = await next()) {
        if (step.done) return { chunks, returned: step.value };
        chunks.push(step.value);
      }
    };
    const wrapped = wrapWorkflow({
      id: "stream",
      effects: { tokens },
      run: async (via: "iterator" | "generator", fx) => {
        const stream = await fx.tokens();
        // Through `[Symbol.asyncIterator]()`, or `next()` on the generator itself.
        const iterator = via === "iterator" ? stream[Symbol.asyncIterator]() : stream;
        return read(() => iterator.next());
      },
    });
    for (const via of ["iterator", "generator"] as const) {
      const done: unknown[] = [];
      const out = await wrapped.run(via, {
        onTransition: (_s, event) => {
          if (event.type === "effect.done") done.push(event.result);
        },
      });
      expect(out.returned).toBe(log);
      expect(out.chunks).toEqual(["a", "b"]);
      expect(done).toEqual([{ chunks: ["a", "b"], returned: log }]);
    }
  });

  test("a streaming effect's other properties reach the original, bound to it", async () => {
    class Stream {
      total = 2;
      async *[Symbol.asyncIterator]() {
        yield this.total;
      }
      describe() {
        return `total ${this.total}`;
      }
    }
    const wrapped = wrapWorkflow({
      id: "stream",
      effects: { open: async () => new Stream() },
      run: async (_input: null, fx) => {
        const stream = await fx.open();
        const chunks: number[] = [];
        for await (const chunk of stream) chunks.push(chunk);
        return [stream.total, stream.describe(), chunks] as const;
      },
    });
    expect(await wrapped.run(null)).toEqual([2, "total 2", [2]]);
  });

  test("the workflow owns its input: mutating a frozen input does not throw or touch context", async () => {
    const deepFreeze = <T>(value: T): T => {
      for (const child of Object.values(value as object))
        if (child && typeof child === "object") deepFreeze(child);
      return Object.freeze(value);
    };
    const input = deepFreeze({ messages: [{ role: "user", content: "hi" }] });
    const wrapped = wrapWorkflow({
      id: "mutates",
      effects: {},
      run: async (value: typeof input) => {
        (value.messages[0] as { content: string }).content = "mutated";
        return value.messages[0]!.content;
      },
    });
    let context: unknown;
    const out = await wrapped.run(input, {
      onTransition: (snapshot) => void (context = snapshot.context.input),
    });
    expect(out).toBe("mutated");
    expect(context).toEqual({ messages: [{ role: "user", content: "hi" }] });
    expect(input.messages[0]!.content).toBe("hi");
  });

  test("an input structuredClone cannot copy reaches the workflow as is", async () => {
    const input = { callback: () => "called" };
    const wrapped = wrapWorkflow({
      id: "uncloneable",
      effects: {},
      run: async (value: typeof input) => [value === input, value.callback()] as const,
    });
    expect(await wrapped.run(input)).toEqual([true, "called"]);
  });

  test("an input holding a class instance reaches the workflow as is", async () => {
    class Message {
      constructor(public content: string) {}
    }
    const input = { messages: [new Message("hi")] };
    const wrapped = wrapWorkflow({
      id: "instances",
      effects: {},
      run: async (value: typeof input) => [value === input, value.messages[0] instanceof Message],
    });
    expect(await wrapped.run(input)).toEqual([true, true]);
  });

  test("run leaves the caller's input unfrozen", async () => {
    class Message {
      constructor(public content: string) {}
    }
    const plain = { messages: [{ role: "user", content: "hi" }], meta: { n: 1 } };
    const mixed = { messages: [new Message("hi")], callback: () => "called" };
    const wrapped = wrapWorkflow({ id: "unfrozen", effects: {}, run: async () => "ok" });
    await wrapped.run(plain);
    await wrapped.run(mixed as never);
    for (const value of [
      plain,
      plain.messages,
      plain.messages[0],
      plain.meta,
      mixed,
      mixed.messages,
    ])
      expect(Object.isFrozen(value)).toBe(false);
  });

  test("runAgent on the machine leaves the caller's input unfrozen", async () => {
    const input = { messages: [{ role: "user", content: "hi" }] };
    const wrapped = wrapWorkflow({ id: "unfrozen-machine", effects: {}, run: async () => "ok" });
    await runAgent(wrapped.machine, { input });
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.messages[0])).toBe(false);
  });

  test("runAgent on the machine keeps symbol and non-enumerable input fields", async () => {
    const tag = Symbol("tag");
    const input = Object.defineProperty({ id: "a", [tag]: 1 }, "token", { value: "secret" }) as {
      id: string;
      [tag]: number;
      token?: string;
    };
    const wrapped = wrapWorkflow({
      id: "hidden-fields",
      effects: {},
      run: async (value: typeof input) => [value.id, value[tag], value.token],
    });
    const result = await runAgent(wrapped.machine, { input });
    expect(result.status === "done" && result.output).toEqual(["a", 1, "secret"]);
    expect(Object.isFrozen(input)).toBe(false);
  });

  test("runAgent on the machine hands a mixed input to the workflow as is", async () => {
    class Message {
      constructor(public content: string) {}
    }
    const input = { messages: [new Message("hi")], callback: () => "called" };
    const wrapped = wrapWorkflow({
      id: "mixed-machine",
      effects: {},
      run: async (value: typeof input) => [value === input, value.callback()] as const,
    });
    const result = await runAgent(wrapped.machine, { input });
    expect(result.status === "done" && result.output).toEqual([true, "called"]);
    expect(Object.isFrozen(input)).toBe(false);
  });

  test("an own __proto__ input key stays an own key", async () => {
    const input = JSON.parse('{"__proto__":{"flag":true}}') as Record<string, unknown>;
    const wrapped = wrapWorkflow({
      id: "proto-key",
      effects: {},
      run: async (value: Record<string, unknown>) => Object.keys(value),
    });
    let context: unknown;
    await runAgent(wrapped.machine, {
      input,
      onTransition: (snapshot) => void (context = snapshot.context.input),
    });
    expect(Object.keys(context as object)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(context)).toBe(Object.prototype);
  });

  test("a plain input with hidden keys is still the workflow's own copy", async () => {
    const tag = Symbol("tag");
    const input = Object.defineProperty({ id: "a", [tag]: 1 }, "token", { value: "secret" }) as {
      id: string;
      [tag]: number;
      token?: string;
    };
    const wrapped = wrapWorkflow({
      id: "hidden-copy",
      effects: {},
      run: async (value: typeof input) => {
        value.id = "mutated";
        return [value === input, value[tag], value.token];
      },
    });
    expect(await wrapped.run(input)).toEqual([false, 1, "secret"]);
    expect(input.id).toBe("a");
  });

  test("a sparse input array keeps its length in context", async () => {
    const wrapped = wrapWorkflow({ id: "sparse", effects: {}, run: async () => "ok" });
    let context: unknown;
    await wrapped.run({ slots: new Array(3) } as never, {
      onTransition: (snapshot) => void (context = snapshot.context.input),
    });
    expect((context as { slots: unknown[] }).slots.length).toBe(3);
  });
});
