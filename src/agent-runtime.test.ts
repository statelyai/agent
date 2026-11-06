/**
 * The loop contract of `createAgentRuntime`: `execute` only starts work, one
 * mailbox hands out the first arrival, one event per transition, and a run
 * settles when nothing is in flight — not when the machine looks idle.
 */
import { describe, expect, test, vi } from "vitest";
import { createMachine, initialTransition, type InspectionEvent } from "xstate";
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
  test("restored child transitions still reach the inspector", async () => {
    const child = createMachine({
      initial: "waiting",
      states: { waiting: { on: { PING: { target: "ready" } } }, ready: {} },
    });
    const machine = createMachine({ actors: { child }, invoke: { id: "child", src: "child" } });
    const [initial] = initialTransition(machine);
    const inspected: InspectionEvent[] = [];
    const runtime = createAgentRuntime(machine, { inspect: (event) => inspected.push(event) });
    const [snapshot, effects] = await runtime.start({
      snapshot: JSON.parse(JSON.stringify(machine.getPersistedSnapshot(initial))),
    });
    await runtime.execute(effects);
    const childRef = snapshot.children.child!;
    childRef.send({ type: "PING" });
    expect(
      inspected.some(
        (event) =>
          event.type === "@xstate.transition" &&
          // A stable handle per actor session, not the step's actor object.
          event.actorRef.sessionId === childRef.sessionId &&
          event.event.type === "PING",
      ),
    ).toBe(true);
    await runtime.finish();
  });
  test("restoration never probes a wildcard transition", async () => {
    const wildcard = vi.fn(() => ({ target: "wrong" as const }));
    const machine = createMachine({
      id: "wildcard-restore",
      initial: "waiting",
      states: {
        waiting: { on: { "*": wildcard } },
        wrong: { type: "final" },
      },
    });
    const [snapshot] = initialTransition(machine);
    const result = await runToQuiescence(createAgentRuntime(machine), {
      snapshot: JSON.parse(JSON.stringify(machine.getPersistedSnapshot(snapshot))),
    });
    expect(result.status).toBe("idle");
    expect(result.snapshot.value).toBe("waiting");
    expect(wildcard).not.toHaveBeenCalled();
  });
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
    for (let event; (event = await runtime.nextEvent());) {
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

  const childTimed = setupAgent({
    context: z.object({}),
    output: z.object({ expired: z.boolean() }),
    actors: {
      worker: createMachine({
        initial: "waiting",
        states: {
          waiting: { after: { 20: { target: "expired" } } },
          expired: { type: "final" },
        },
      }),
    },
  }).createMachine({
    context: {},
    initial: "running",
    states: {
      running: { invoke: { src: "worker", id: "worker", onDone: { target: "expired" } } },
      expired: { type: "final", output: () => ({ expired: true }) },
    },
  });

  test("a child machine's `after` timer fires and keeps the loop reading", async () => {
    const result = await runToQuiescence(createAgentRuntime(childTimed));
    expect(result.status).toBe("done");
    expect(result.status === "done" ? result.output : undefined).toEqual({ expired: true });
  });

  test("host-owned timers: a child machine's timer still runs in process", async () => {
    const scheduled: Array<{ id: string; delay: number }> = [];
    const host = {
      schedule: (timer: { id: string; delay: number }) => scheduled.push(timer),
      cancel: () => {},
    };
    const result = await runToQuiescence(createAgentRuntime(childTimed, { timers: host }));
    expect(result.status).toBe("done");
    expect(scheduled).toEqual([]);
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

describe("AgentRuntime.send", () => {
  // `work` stays pending until its gate opens; NOTE records arrivals without
  // leaving the state, CANCEL leaves it (stopping the request).
  const worker = setupAgent({
    context: z.object({ log: z.array(z.string()) }),
    output: z.object({ log: z.array(z.string()) }),
    events: { NOTE: z.object({ text: z.string() }), CANCEL: z.object({}) },
    requests: { work: text("work") },
  }).createMachine({
    context: { log: [] },
    initial: "working",
    states: {
      working: {
        invoke: {
          src: "work",
          input: {},
          onDone: {
            target: "done",
            context: ({ context, event }) => ({ log: [...context.log, event.output.result] }),
          },
        },
        on: {
          NOTE: { context: ({ context, event }) => ({ log: [...context.log, event.text] }) },
          CANCEL: { target: "cancelled" },
        },
      },
      cancelled: { type: "final", output: ({ context }) => context },
      done: { type: "final", output: ({ context }) => context },
    },
  });

  async function drive(runtime: ReturnType<typeof createAgentRuntime<typeof worker>>) {
    let [state, effects] = await runtime.start();
    await runtime.execute(effects);
    for (let event; (event = await runtime.nextEvent());) {
      [state, effects] = runtime.transition(state, event);
      await runtime.execute(effects);
    }
    return runtime.finish();
  }

  test("a sent event interleaves with a pending invoke, in arrival order", async () => {
    const gate = deferred();
    const runtime = createAgentRuntime(worker, {
      executors: gatedExecutors({ work: gate.promise }).executors,
    });
    const settled = drive(runtime);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(runtime.send({ type: "NOTE", text: "first" })).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(runtime.send({ type: "NOTE", text: "second" })).toBe(true);
    gate.resolve();
    const result = await settled;
    expect(result.status === "done" ? result.output.log : undefined).toEqual([
      "first",
      "second",
      "work done",
    ]);
    expect(result.ignored).toBeUndefined();
    // Journaled like any delivered event.
    expect(result.events.map((entry) => entry.event.type)).toEqual([
      "@agent.init",
      "NOTE",
      "NOTE",
      expect.stringMatching(/^xstate\.done\.actor/),
    ]);
  });

  test("abort mid-invoke: a sent CANCEL leaves the state and aborts the request", async () => {
    let requestSignal: AbortSignal | undefined;
    const runtime = createAgentRuntime(worker, {
      executors: {
        generateText: (_request, info) => {
          requestSignal = info?.signal;
          return new Promise(() => {});
        },
      },
    });
    const settled = drive(runtime);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(requestSignal?.aborted).toBe(false);
    runtime.send({ type: "CANCEL" });
    const result = await settled;
    expect(result.status).toBe("done");
    expect(result.snapshot.value).toBe("cancelled");
    expect(requestSignal?.aborted).toBe(true);
  });

  test("replaying the log of a run with sent events lands on the same state", async () => {
    const gate = deferred();
    const runtime = createAgentRuntime(worker, {
      executors: gatedExecutors({ work: gate.promise }).executors,
    });
    const settled = drive(runtime);
    await new Promise((resolve) => setTimeout(resolve, 5));
    runtime.send({ type: "NOTE", text: "hi" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    runtime.send({ type: "CANCEL" });
    const result = await settled;
    const replayed = replay(worker, result.events);
    expect(replayed.snapshot.value).toBe("cancelled");
    expect(replayed.snapshot.context).toEqual(result.snapshot.context);
    expect(result.snapshot.context).toEqual({ log: ["hi"] });
  });

  test("before start: queued and handed out by the first nextEvent", async () => {
    const runtime = createAgentRuntime(worker, {
      executors: { generateText: () => new Promise(() => {}) },
    });
    expect(runtime.send({ type: "CANCEL" })).toBe(true);
    const result = await drive(runtime);
    expect(result.snapshot.value).toBe("cancelled");
  });

  test("after the machine is done: dropped (false); after finish: throws", async () => {
    const runtime = createAgentRuntime(worker, { executors: gatedExecutors().executors });
    let [state, effects] = await runtime.start();
    await runtime.execute(effects);
    for (let event; (event = await runtime.nextEvent());) {
      [state, effects] = runtime.transition(state, event);
      await runtime.execute(effects);
    }
    expect(state.status).toBe("done");
    expect(runtime.send({ type: "NOTE", text: "late" })).toBe(false);
    await runtime.finish();
    expect(() => runtime.send({ type: "CANCEL" })).toThrow(/finished/);
  });

  test("synchronous cancel: a direct transition on the loop's state, then the loop exits", async () => {
    let requestSignal: AbortSignal | undefined;
    const runtime = createAgentRuntime(worker, {
      executors: {
        generateText: (_request, info) => {
          requestSignal = info?.signal;
          return new Promise(() => {});
        },
      },
    });
    let [state, effects] = await runtime.start();
    await runtime.execute(effects);
    const loop = (async () => {
      for (let event; (event = await runtime.nextEvent());) {
        [state, effects] = runtime.transition(state, event);
        await runtime.execute(effects);
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 5));
    [state, effects] = runtime.transition(state, { type: "CANCEL" });
    await runtime.execute(effects);
    // Applied before the caller continues.
    expect(state.value).toBe("cancelled");
    expect(requestSignal?.aborted).toBe(true);
    await loop;
    const result = await runtime.finish();
    expect(result.snapshot.value).toBe("cancelled");
  });

  test("an unhandled sent event is reported as ignored", async () => {
    const gate = deferred();
    const runtime = createAgentRuntime(worker, {
      executors: gatedExecutors({ work: gate.promise }).executors,
    });
    const settled = drive(runtime);
    await new Promise((resolve) => setTimeout(resolve, 5));
    runtime.send({ type: "BOGUS" } as never);
    await new Promise((resolve) => setTimeout(resolve, 5));
    gate.resolve();
    const result = await settled;
    expect(result.status).toBe("done");
    expect(result.ignored?.type).toBe("BOGUS");
  });
});

describe("abortWith", () => {
  const worker = setupAgent({
    context: z.object({ cleaned: z.boolean() }),
    output: z.object({ cleaned: z.boolean() }),
    events: { CANCEL: z.object({}) },
    requests: { work: text("work"), cleanup: text("cleanup") },
  }).createMachine({
    context: { cleaned: false },
    initial: "working",
    states: {
      working: {
        invoke: { src: "work", input: {}, onDone: { target: "done" } },
        on: { CANCEL: { target: "cleaning" } },
      },
      cleaning: {
        invoke: {
          src: "cleanup",
          input: {},
          onDone: { target: "aborted", context: { cleaned: true } },
        },
      },
      aborted: { type: "final", output: ({ context }) => context },
      done: { type: "final", output: ({ context }) => context },
    },
  });
  const hangingWork = (): AgentRequestExecutors => ({
    generateText: async (request) =>
      request.name === "work" ? new Promise(() => {}) : { result: "ok" },
  });

  test("the machine handles the abort event and settles on its own final state", async () => {
    const controller = new AbortController();
    const settled = runToQuiescence(
      createAgentRuntime(worker, {
        signal: controller.signal,
        abortWith: { event: { type: "CANCEL" } },
        executors: hangingWork(),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    const result = await settled;
    expect(result.status).toBe("done");
    expect(result.snapshot.value).toBe("aborted");
    expect(result.status === "done" ? result.output : undefined).toEqual({ cleaned: true });
    expect(result.events.map((entry) => entry.event.type)).toContain("CANCEL");
  });

  test("an already-aborted signal delivers the event first", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runToQuiescence(
      createAgentRuntime(worker, {
        signal: controller.signal,
        abortWith: { event: { type: "CANCEL" } },
        executors: hangingWork(),
      }),
    );
    expect(result.snapshot.value).toBe("aborted");
  });

  test("an unhandled abort event falls back to the aborted settle", async () => {
    const controller = new AbortController();
    const settled = runToQuiescence(
      createAgentRuntime(worker, {
        signal: controller.signal,
        abortWith: { event: { type: "NOPE" } as never },
        executors: hangingWork(),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    const result = await settled;
    expect(result.status === "error" ? result.cause : undefined).toBe("aborted");
    expect(result.ignored).toBeUndefined();
  });

  test("timeout: a machine that does not settle in time is aborted", async () => {
    const controller = new AbortController();
    const settled = runToQuiescence(
      createAgentRuntime(worker, {
        signal: controller.signal,
        abortWith: { event: { type: "CANCEL" }, timeout: 10 },
        executors: { generateText: () => new Promise(() => {}) },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    const result = await settled;
    expect(result.status === "error" ? result.cause : undefined).toBe("aborted");
    expect(result.snapshot.value).toBe("cleaning");
  });
});

describe("abortWith: abort comes first, and an unfinished wind-down aborts", () => {
  const machine = setupAgent({
    context: z.object({}),
    events: { CANCEL: z.object({}), FINISH: z.object({}), CONFIRM: z.object({}) },
    requests: { work: text("work") },
  }).createMachine({
    context: {},
    initial: "working",
    states: {
      working: {
        invoke: { src: "work", input: {}, onDone: { target: "done" } },
        on: { CANCEL: { target: "cancelled" }, FINISH: { target: "done" } },
      },
      // Handles the abort, then waits on a host event that never comes.
      cancelled: { on: { CONFIRM: { target: "done" } } },
      done: { type: "final" },
    },
  });
  const hanging: AgentRequestExecutors = { generateText: () => new Promise(() => {}) };

  test("pre-aborted signal: the abort event goes before an init event that would finish the run", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runToQuiescence(
      createAgentRuntime(machine, {
        signal: controller.signal,
        abortWith: { event: { type: "CANCEL" } },
        executors: hanging,
      }),
      { event: { type: "FINISH" } },
    );
    expect(result.status).toBe("error");
    expect(result.status === "error" ? result.cause : undefined).toBe("aborted");
    const types = result.events.map((entry) => entry.event.type);
    expect(types).toContain("CANCEL");
    expect(types).not.toContain("FINISH");
  });

  test("abort handled but the machine rests short of a final state: settles aborted", async () => {
    const controller = new AbortController();
    const settled = runToQuiescence(
      createAgentRuntime(machine, {
        signal: controller.signal,
        abortWith: { event: { type: "CANCEL" }, timeout: 60_000 },
        executors: hanging,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    const result = await settled;
    expect(result.status === "error" ? result.cause : undefined).toBe("aborted");
    expect(result.snapshot.value).toBe("cancelled");
  });
});
