/**
 * The loop contract of `createAgentRuntime`: `execute` only starts work, one
 * mailbox hands out the first arrival, one event per transition, and a run
 * settles when nothing is in flight — not when the machine looks idle.
 */
import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  createAgentRuntime,
  runToQuiescence,
  setupAgent,
  type AgentRequestExecutors,
} from "./index.js";
import { replay } from "./log/index.js";

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const text = (name: string) => ({
  schemas: { input: z.object({}), output: z.string() },
  model: "m",
  prompt: () => name,
});

/** Answers each request with `<name> done`, after that request's gate opens (if any). */
function gatedExecutors(gates: Record<string, Promise<void>> = {}): {
  executors: AgentRequestExecutors;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    executors: {
      generateText: async (request) => {
        calls.push(request.name);
        await gates[request.name];
        return { result: `${request.name} done` };
      },
    },
  };
}

describe("createAgentRuntime", () => {
  const sequence = setupAgent({
    context: z.object({ a: z.string().nullable(), b: z.string().nullable() }),
    output: z.object({ a: z.string().nullable(), b: z.string().nullable() }),
    requests: { first: text("first"), second: text("second") },
  }).createMachine({
    context: { a: null, b: null },
    initial: "one",
    states: {
      one: {
        invoke: {
          src: "first",
          input: {},
          onDone: { target: "two", context: ({ event }) => ({ a: event.output.result }) },
        },
      },
      two: {
        invoke: {
          src: "second",
          input: {},
          onDone: { target: "done", context: ({ event }) => ({ b: event.output.result }) },
        },
      },
      done: { type: "final", output: ({ context }) => context },
    },
  });

  test("a hand-written loop and runToQuiescence produce the same run", async () => {
    const manualEvents: string[] = [];
    const runtime = createAgentRuntime(sequence, {
      executors: gatedExecutors().executors,
      onTransition: (_snapshot, event) => manualEvents.push(event.type),
    });
    let [state, effects] = await runtime.start();
    await runtime.execute(effects);
    for (let event; (event = await runtime.nextEvent()); ) {
      [state, effects] = runtime.transition(state, event);
      await runtime.execute(effects);
    }
    const manual = await runtime.finish();

    const helperEvents: string[] = [];
    const helper = await runToQuiescence(
      createAgentRuntime(sequence, {
        executors: gatedExecutors().executors,
        onTransition: (_snapshot, event) => helperEvents.push(event.type),
      }),
    );

    expect(manual.status).toBe("done");
    expect(manual.status === "done" ? manual.output : undefined).toEqual({
      a: "first done",
      b: "second done",
    });
    expect(helper.status === "done" ? helper.output : undefined).toEqual(
      manual.status === "done" ? manual.output : undefined,
    );
    expect(helperEvents).toEqual(manualEvents);
    expect(state.status).toBe("done");
  });

  test("execute only starts work: it returns before the request finishes", async () => {
    const gate = deferred();
    const { executors, calls } = gatedExecutors({ first: gate.promise });
    const runtime = createAgentRuntime(sequence, { executors });
    const [, effects] = await runtime.start();
    await runtime.execute(effects);
    // The request started, and execute came back without waiting for it.
    expect(calls).toEqual(["first"]);

    const next = runtime.nextEvent();
    gate.resolve();
    expect((await next)?.type).toMatch(/^xstate\.done\.actor/);
  });

  test("parallel requests: the mailbox hands out the first arrival, one per transition", async () => {
    const slow = deferred();
    const fast = deferred();
    const machine = setupAgent({
      context: z.object({ order: z.array(z.string()) }),
      output: z.object({ order: z.array(z.string()) }),
      requests: { slow: text("slow"), fast: text("fast") },
    }).createMachine({
      context: { order: [] },
      type: "parallel",
      states: {
        left: {
          initial: "working",
          states: {
            working: {
              invoke: {
                src: "slow",
                input: {},
                onDone: {
                  target: "done",
                  context: ({ context }) => ({ order: [...context.order, "slow"] }),
                },
              },
            },
            done: { type: "final" },
          },
        },
        right: {
          initial: "working",
          states: {
            working: {
              invoke: {
                src: "fast",
                input: {},
                onDone: {
                  target: "done",
                  context: ({ context }) => ({ order: [...context.order, "fast"] }),
                },
              },
            },
            done: { type: "final" },
          },
        },
      },
      output: ({ context }) => context,
    });

    const { executors, calls } = gatedExecutors({ slow: slow.promise, fast: fast.promise });
    const runtime = createAgentRuntime(machine, { executors });
    let [state, effects] = await runtime.start();
    await runtime.execute(effects);
    expect(calls.sort()).toEqual(["fast", "slow"]);

    // `fast` finishes first although `slow` was invoked first.
    fast.resolve();
    const first = await runtime.nextEvent();
    [state, effects] = runtime.transition(state, first!);
    await runtime.execute(effects);
    expect(state.context.order).toEqual(["fast"]);

    slow.resolve();
    const second = await runtime.nextEvent();
    [state, effects] = runtime.transition(state, second!);
    await runtime.execute(effects);
    expect(state.context.order).toEqual(["fast", "slow"]);

    expect(await runtime.nextEvent()).toBeUndefined();
    const result = await runtime.finish();
    expect(result.status === "done" ? result.output : undefined).toEqual({
      order: ["fast", "slow"],
    });
  });

  test("a human wait does not stop the loop while a sibling region is still working", async () => {
    const gate = deferred();
    const machine = setupAgent({
      context: z.object({ report: z.string().nullable() }),
      events: { APPROVE: z.object({}) },
      requests: { research: text("research") },
    }).createMachine({
      context: { report: null },
      type: "parallel",
      states: {
        ask: {
          initial: "waiting",
          states: {
            waiting: {
              meta: { interaction: { label: "Approve?" } },
              on: { APPROVE: { target: "approved" } },
            },
            approved: {},
          },
        },
        work: {
          initial: "researching",
          states: {
            researching: {
              invoke: {
                src: "research",
                input: {},
                onDone: {
                  target: "ready",
                  context: ({ event }) => ({ report: event.output.result }),
                },
              },
            },
            ready: {},
          },
        },
      },
    });

    const { executors } = gatedExecutors({ research: gate.promise });
    const result = runToQuiescence(createAgentRuntime(machine, { executors }));
    let settled = false;
    void result.then(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The machine is already asking a person, but research is in flight.
    expect(settled).toBe(false);

    gate.resolve();
    const settledResult = await result;
    expect(settledResult.status).toBe("idle");
    if (settledResult.status !== "idle") throw new Error("expected idle");
    expect(settledResult.snapshot.context.report).toBe("research done");
    expect(settledResult.snapshot.value).toEqual({ ask: "waiting", work: "ready" });
  });

  test("an event sent to a child machine starts its work before the run settles", async () => {
    const gate = deferred();
    const child = setupAgent({
      context: z.object({ answer: z.string().nullable() }),
      events: { ASK: z.object({}) },
      requests: { research: text("research") },
    }).createMachine({
      context: { answer: null },
      initial: "idle",
      states: {
        idle: { on: { ASK: { target: "working" } } },
        working: {
          invoke: {
            src: "research",
            input: {},
            onDone: ({ event, parent }, enq) => {
              if (parent) enq.sendTo(parent, { type: "ANSWERED", answer: event.output.result });
              return { target: "idle" };
            },
          },
        },
      },
    });
    const machine = setupAgent({
      context: z.object({ answer: z.string().nullable() }),
      events: { GO: z.object({}), ANSWERED: z.object({ answer: z.string() }) },
      actors: { child },
    }).createMachine({
      context: { answer: null },
      invoke: { id: "child", src: "child" },
      initial: "waiting",
      states: {
        waiting: {
          on: {
            GO: ({ children }, enq) => {
              enq.sendTo(children.child, { type: "ASK" });
              return { target: "asked" };
            },
          },
        },
        asked: {
          on: {
            ANSWERED: ({ event }) => ({ target: "answered", context: { answer: event.answer } }),
          },
        },
        answered: {},
      },
    });

    const { executors } = gatedExecutors({ research: gate.promise });
    const first = await runToQuiescence(createAgentRuntime(machine, { executors }));
    expect(first.status).toBe("idle");
    const run = runToQuiescence(createAgentRuntime(machine, { executors }), {
      snapshot: first.persist(),
      event: { type: "GO" },
    });
    setTimeout(() => gate.resolve(), 20);
    const result = await run;
    // The run waited for the child's request instead of settling in `asked`.
    expect(result.status === "idle" ? result.snapshot.value : undefined).toBe("answered");
  });

  const timed = setupAgent({
    context: z.object({}),
    output: z.object({ expired: z.boolean() }),
  }).createMachine({
    context: {},
    initial: "waiting",
    states: {
      waiting: { after: { 20: { target: "expired" } } },
      expired: { type: "final", output: () => ({ expired: true }) },
    },
  });

  test("an in-process `after` timer counts as work in flight and fires", async () => {
    const result = await runToQuiescence(createAgentRuntime(timed));
    expect(result.status).toBe("done");
    expect(result.status === "done" ? result.output : undefined).toEqual({ expired: true });
  });

  test("host-owned timers: the loop settles with the timer scheduled, and the host delivers it", async () => {
    const scheduled: Array<{ id: string; delay: number }> = [];
    const host = {
      schedule: (timer: { id: string; delay: number }) => scheduled.push(timer),
      cancel: () => {},
    };

    const first = await runToQuiescence(createAgentRuntime(timed, { timers: host }));
    // Nothing in the process is waiting on the timer, so the run settles now.
    expect(first.status).toBe("idle");
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.delay).toBe(20);

    // Later, the host's durable timer fires and it resumes the run with it.
    const resumed = await runToQuiescence(createAgentRuntime(timed, { timers: host }), {
      snapshot: first.persist(),
      event: { type: "xstate.timer", id: scheduled[0]!.id } as never,
    });
    expect(resumed.status).toBe("done");
    expect(resumed.status === "done" ? resumed.output : undefined).toEqual({ expired: true });
  });

  test("a pending timer resumes with what is left of its delay, not the whole delay", async () => {
    const scheduled: Array<{ id: string; delay: number }> = [];
    const host = {
      schedule: (timer: { id: string; delay: number }) => scheduled.push(timer),
      cancel: () => {},
    };
    const machine = setupAgent({
      context: z.object({}),
      events: { PING: z.object({}) },
    }).createMachine({
      context: {},
      initial: "waiting",
      states: {
        waiting: {
          after: { 1000: { target: "expired" } },
          on: { PING: {} },
        },
        expired: { type: "final" },
      },
    });

    const first = await runToQuiescence(createAgentRuntime(machine, { timers: host }));
    expect(scheduled[0]!.delay).toBe(1000);
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Resumed for an unrelated event: the deadline is re-armed for what is left.
    await runToQuiescence(createAgentRuntime(machine, { timers: host }), {
      snapshot: JSON.parse(JSON.stringify(first.persist())),
      event: { type: "PING" },
    });
    const rearmed = scheduled.at(-1)!;
    expect(rearmed.id).toBe(scheduled[0]!.id);
    expect(rearmed.delay).toBeLessThanOrEqual(750);
    expect(rearmed.delay).toBeGreaterThan(500);
  });

  test("a decision's completion after its chosen event moved the machine on is ignored", async () => {
    const machine = setupAgent({
      context: z.object({}),
      events: { GO: z.object({}) },
    }).createMachine({
      context: {},
      initial: "deciding",
      states: {
        deciding: {
          invoke: {
            src: "agent.decide",
            input: { model: "m", prompt: "Go?", allowedEvents: ["GO"] as const },
          },
          on: { GO: { target: "gone" } },
        },
        gone: { type: "final" },
      },
    });

    const seen: string[] = [];
    const result = await runToQuiescence(
      createAgentRuntime(machine, {
        executors: { decide: async () => ({ event: { type: "GO" } }) },
        onTransition: (_snapshot, event) => seen.push(event.type),
      }),
    );
    expect(result.status).toBe("done");
    expect(seen).toContain("GO");
    expect(seen.some((type) => type.startsWith("xstate.done.actor"))).toBe(false);

    // Never journaled either, so replaying the log lands on the same state.
    const journaled = result.events.map((entry) => entry.event.type);
    expect(journaled.some((type) => type.startsWith("xstate.done.actor"))).toBe(false);
    const replayed = replay(machine, result.events);
    expect(replayed.snapshot.value).toBe(result.snapshot.value);
    expect(replayed.snapshot.status).toBe("done");
  });

  test("abort stops the loop and aborts the in-flight request's signal", async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const runtime = createAgentRuntime(sequence, {
      signal: controller.signal,
      executors: {
        generateText: (_request, info) => {
          requestSignal = info?.signal;
          return new Promise(() => {});
        },
      },
    });
    const result = runToQuiescence(runtime);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(requestSignal?.aborted).toBe(false);

    controller.abort();
    const settled = await result;
    expect(settled.status).toBe("error");
    expect(settled.status === "error" ? settled.cause : undefined).toBe("aborted");
    expect(requestSignal?.aborted).toBe(true);
  });

  test("resuming a snapshot taken mid-request restarts that request", async () => {
    const controller = new AbortController();
    const first = runToQuiescence(
      createAgentRuntime(sequence, {
        signal: controller.signal,
        executors: { generateText: () => new Promise(() => {}) },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    const stopped = await first;
    expect(stopped.status).toBe("error");

    const { executors, calls } = gatedExecutors();
    const resumed = await runToQuiescence(createAgentRuntime(sequence, { executors }), {
      snapshot: stopped.persist(),
    });
    expect(calls).toEqual(["first", "second"]);
    expect(resumed.status === "done" ? resumed.output : undefined).toEqual({
      a: "first done",
      b: "second done",
    });
  });
});
