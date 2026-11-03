import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createAsyncLogic, createMachine, type AnyStateMachine } from "xstate";
import { setupAgent } from "./index.js";
import { canReach, explorePaths } from "./testing/index.js";
import { isExplorationComplete } from "./verify.js";

type Enq = { sendTo: (to: unknown, event: unknown) => void };
const tell =
  (type: string) =>
  ({ parent }: { parent?: unknown }, enq: Enq) => {
    if (parent) enq.sendTo(parent, { type });
  };

describe("explorePaths — children: 'coupled'", () => {
  // Reports STARTED on entry, FINISHED once the host says END.
  const worker = createMachine({
    initial: "started",
    states: {
      started: { entry: tell("STARTED"), on: { END: { target: "finished" } } },
      finished: { entry: tell("FINISHED"), type: "final", output: () => ({ ok: true }) },
    },
  } as never) as AnyStateMachine;

  function createWatcher() {
    const agent = setupAgent({
      context: z.object({}),
      events: { STARTED: z.object({}), FINISHED: z.object({}) },
      actors: { worker },
    });
    return agent.createMachine({
      context: {},
      initial: "waiting",
      states: {
        waiting: {
          invoke: { id: "worker", src: "worker", onDone: { target: "done" } },
          on: { STARTED: { target: "running" }, FINISHED: { target: "outOfOrder" } },
        },
        running: {
          invoke: { id: "worker2", src: "worker", onDone: { target: "done" } },
          on: { FINISHED: { target: "done" } },
        },
        outOfOrder: { type: "final" },
        done: { type: "final" },
      },
    });
  }

  test("'explore' delivers a child's events in any order: a spurious witness", async () => {
    const result = await canReach(createWatcher(), "outOfOrder", {
      children: "explore",
      childEvents: { worker: ["END"] },
    });
    expect(result.reachable).toBe(true);
  });

  test("'coupled' delivers a child's events in its own order", async () => {
    const options = { children: "coupled" as const, childEvents: { worker: ["END"] } };
    const result = await canReach(createWatcher(), "outOfOrder", options);
    expect({ reachable: result.reachable, complete: result.complete }).toEqual({
      reachable: false,
      complete: true,
    });
    const done = await canReach(createWatcher(), "done", options);
    expect(done.reachable).toBe(true);
  });

  // Each child pauses for the host's approval, tells its parent READY, and
  // runs only when its PARENT sends RELEASE.
  const approver = createMachine({
    context: ({ input }: { input: { id: string } }) => ({ id: input.id }),
    initial: "asking",
    states: {
      asking: { on: { APPROVE: { target: "approved" }, REJECT: { target: "rejected" } } },
      approved: { entry: tell("READY"), on: { RELEASE: { target: "ran" } } },
      ran: {
        type: "final",
        output: ({ context }: { context: { id: string } }) => ({ id: context.id, ran: true }),
      },
      rejected: {
        type: "final",
        output: ({ context }: { context: { id: string } }) => ({ id: context.id, ran: false }),
      },
    },
  } as never) as AnyStateMachine;

  // Releases both approvers once both are READY. A child that ran before the
  // release is the bug the sentinel catches.
  function createBatch() {
    const agent = setupAgent({
      context: z.object({ ready: z.number(), settled: z.number() }),
      events: { READY: z.object({}) },
      actors: { approver },
    });
    return agent.createMachine({
      context: { ready: 0, settled: 0 },
      initial: "waiting",
      states: {
        waiting: {
          entry: ({ actors }, enq) => {
            enq.spawn(actors.approver, { id: "a1", input: { id: "a1" } });
            enq.spawn(actors.approver, { id: "a2", input: { id: "a2" } });
          },
          on: {
            READY: ({ context, children }, enq) => {
              if (context.ready + 1 < 2) return { context: { ready: context.ready + 1 } };
              enq.sendTo(children["a1"] as never, { type: "RELEASE" });
              enq.sendTo(children["a2"] as never, { type: "RELEASE" });
              return { target: "released", context: { ready: 2 } };
            },
            "xstate.done.actor": ({ event }) =>
              (event as { output?: { ran?: boolean } }).output?.ran
                ? { target: "ranEarly" }
                : undefined,
          },
        },
        released: {},
        ranEarly: { type: "final" },
        finished: { type: "final" },
      },
      on: {
        "xstate.done.actor": ({ context }) =>
          context.settled + 1 === 2
            ? { target: ".finished", context: { settled: 2 } }
            : { context: { settled: context.settled + 1 } },
      },
    });
  }

  test("'explore' lets a child run before its parent releases it", async () => {
    const result = await canReach(createBatch(), "ranEarly", {
      children: "explore",
      childEvents: { approver: ["APPROVE", "REJECT", "RELEASE"] },
      maxDepth: 12,
    });
    expect(result.reachable).toBe(true);
  });

  test("'coupled' delivers the parent's sends: no child runs before release", async () => {
    const options = {
      children: "coupled" as const,
      // RELEASE is not listed: only the parent sends it.
      childEvents: { approver: ["APPROVE", "REJECT"] },
      maxDepth: 12,
    };
    const early = await canReach(createBatch(), "ranEarly", options);
    expect({ reachable: early.reachable, complete: early.complete }).toEqual({
      reachable: false,
      complete: true,
    });
    const finished = await canReach(createBatch(), "finished", options);
    expect(finished.reachable).toBe(true);
    expect(finished.witness).toEqual([
      { type: "APPROVE", actor: "a1" },
      { type: "READY" },
      { type: "APPROVE", actor: "a2" },
      { type: "READY" },
      { type: "xstate.done.actor.a1", output: { id: "a1", ran: true } },
      { type: "xstate.done.actor.a2", output: { id: "a2", ran: true } },
    ]);
  });

  test("'coupled' explores to completion with dedupeBy", async () => {
    const report = await explorePaths(createBatch(), {
      children: "coupled",
      childEvents: { approver: ["APPROVE", "REJECT"] },
      maxDepth: 12,
      maxPaths: 10_000,
      dedupeBy: (snapshot) => JSON.stringify([snapshot.value, snapshot.context]),
    });
    expect(isExplorationComplete(report)).toBe(true);
    expect(report.reachedStates).toContain("finished");
    expect(report.reachedStates).not.toContain("ranEarly");
  });

  // A child's output is correlated with the events it sent on the same path.
  const picker = createMachine({
    initial: "choosing",
    states: {
      choosing: { on: { X: { target: "x" }, Y: { target: "y" } } },
      x: { entry: tell("SAW_X"), type: "final", output: () => ({ pick: "x" }) },
      y: { entry: tell("SAW_Y"), type: "final", output: () => ({ pick: "y" }) },
    },
  } as never) as AnyStateMachine;

  function createPickWatcher() {
    const agent = setupAgent({
      context: z.object({ saw: z.string() }),
      events: { SAW_X: z.object({}), SAW_Y: z.object({}) },
      actors: { picker },
    });
    return agent.createMachine({
      context: { saw: "" },
      initial: "watching",
      states: {
        watching: {
          invoke: {
            id: "picker",
            src: "picker",
            onDone: ({ context, event }) =>
              context.saw !== "" && context.saw !== (event.output as { pick: string }).pick
                ? { target: "mismatch" }
                : { target: "matched" },
          },
          on: { SAW_X: { context: { saw: "x" } }, SAW_Y: { context: { saw: "y" } } },
        },
        mismatch: { type: "final" },
        matched: { type: "final" },
      },
    });
  }

  test("'coupled' correlates a child's output with its events", async () => {
    const independent = await canReach(createPickWatcher(), "mismatch", {
      children: "explore",
      childEvents: { picker: ["X", "Y"] },
    });
    expect(independent.reachable).toBe(true);
    const coupled = await canReach(createPickWatcher(), "mismatch", {
      children: "coupled",
      childEvents: { picker: ["X", "Y"] },
    });
    expect({ reachable: coupled.reachable, complete: coupled.complete }).toEqual({
      reachable: false,
      complete: true,
    });
  });

  // The parent's CANCEL can reach a child before or after its work settles.
  const job = setupAgent({
    context: z.object({}),
    actors: { work: createAsyncLogic<{ n: number }>({ run: async () => ({ n: 1 }) }) },
  }).createMachine({
    context: {},
    initial: "working",
    states: {
      working: {
        invoke: { id: "work", src: "work", onDone: { target: "worked" } },
        on: { CANCEL: { target: "cancelled" } },
      },
      worked: { type: "final", output: () => ({ cancelled: false }) },
      cancelled: { type: "final", output: () => ({ cancelled: true }) },
    },
  }) as AnyStateMachine;

  function createCanceller() {
    const agent = setupAgent({
      context: z.object({}),
      events: { STOP: z.object({}) },
      actors: { job },
    });
    return agent.createMachine({
      context: {},
      initial: "running",
      states: {
        running: {
          invoke: {
            id: "job",
            src: "job",
            onDone: ({ event }) =>
              (event.output as { cancelled: boolean }).cancelled
                ? { target: "stopped" }
                : { target: "completed" },
          },
          on: {
            STOP: ({ children }, enq) => {
              enq.sendTo(children["job"] as never, { type: "CANCEL" });
            },
          },
        },
        stopped: { type: "final" },
        completed: { type: "final" },
      },
    });
  }

  test("'coupled' races a parent's send against the child's pending work", async () => {
    const options = {
      children: "coupled" as const,
      interleave: "pending" as const,
      outputs: { work: [{ n: 1 }] },
    };
    expect((await canReach(createCanceller(), "stopped", options)).reachable).toBe(true);
    expect((await canReach(createCanceller(), "completed", options)).reachable).toBe(true);
  });
  test("'coupled' steps a child's own children, nested", async () => {
    // The grandchild reports PING on entry; the middle child relays it up as PONG.
    const grandchild = createMachine({
      initial: "on",
      states: { on: { entry: tell("PING") } },
    } as never) as AnyStateMachine;
    const middle = setupAgent({
      context: z.object({}),
      events: { PING: z.object({}) },
      actors: { grandchild },
    }).createMachine({
      context: {},
      initial: "waiting",
      states: {
        waiting: {
          invoke: { id: "grandchild", src: "grandchild" },
          on: { PING: { target: "relayed" } },
        },
        relayed: { entry: tell("PONG") as never },
      },
    }) as AnyStateMachine;
    const agent = setupAgent({
      context: z.object({}),
      events: { PONG: z.object({}) },
      actors: { middle },
    });
    const machine = agent.createMachine({
      context: {},
      initial: "listening",
      states: {
        listening: { invoke: { id: "middle", src: "middle" }, on: { PONG: { target: "heard" } } },
        heard: { type: "final" },
      },
    });
    const result = await canReach(machine, "heard", { children: "coupled" });
    expect(result).toMatchObject({ reachable: true, complete: true });
    expect(result.witness?.at(-1)).toEqual({ type: "PONG" });
  });

  test("hostEvents limits what the host can send the parent", async () => {
    // The sleeper never reports; WOKE is accepted, but only a child sends it.
    const sleeper = createMachine({
      initial: "asleep",
      states: { asleep: {} },
    } as never) as AnyStateMachine;
    const machine = setupAgent({
      context: z.object({}),
      events: { WOKE: z.object({}) },
      actors: { sleeper },
    }).createMachine({
      context: {},
      initial: "waiting",
      states: {
        waiting: { invoke: { id: "sleeper", src: "sleeper" }, on: { WOKE: { target: "woken" } } },
        woken: { type: "final" },
      },
    });
    const forged = await canReach(machine, "woken", { children: "coupled" });
    expect(forged.reachable).toBe(true);
    const result = await canReach(machine, "woken", { children: "coupled", hostEvents: [] });
    expect(result).toMatchObject({ reachable: false, complete: true });
  });

  test("coupled moves count against the shared budget", async () => {
    const report = await explorePaths(createBatch(), {
      children: "coupled",
      childEvents: { approver: ["APPROVE", "REJECT"] },
      maxDepth: 12,
      maxPaths: 10_000,
      budget: { nodes: 5 },
    });
    expect(report.partial).toBe(true);
    expect(report.complete).toBe(false);
    expect(report.unexplored.some((note) => note.startsWith("budget-exhausted: nodes"))).toBe(true);
  });
  test("a parent and child that keep sending each other end the branch, not the search", async () => {
    const echo = createMachine({
      initial: "on",
      states: {
        on: {
          entry: tell("PONG"),
          on: {
            PING: ({ parent }: { parent?: unknown }, enq: Enq) =>
              void tell("PONG")({ parent }, enq),
          },
        },
      },
    } as never) as AnyStateMachine;
    const machine = setupAgent({
      context: z.object({}),
      events: { PONG: z.object({}) },
      actors: { echo },
    }).createMachine({
      context: {},
      initial: "talking",
      states: {
        talking: {
          invoke: { id: "echo", src: "echo" },
          on: {
            PONG: ({ children }, enq) => {
              enq.sendTo(children["echo"] as never, { type: "PING" });
              return {};
            },
          },
        },
      },
    });
    const report = await explorePaths(machine, { children: "coupled" });
    expect(report.complete).toBe(false);
    expect(report.terminals.map((terminal) => terminal.status)).toEqual(["max-depth"]);
    expect(report.unexplored.some((note) => note.startsWith("coupled: more than"))).toBe(true);
  });
});
