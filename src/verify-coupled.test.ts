import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createAsyncLogic, createMachine, type AnyStateMachine } from "xstate";
import { AGENT_USAGE_EVENT_TYPE, runAgent, setupAgent } from "./index.js";
import { canReach, explorePaths, type ExplorePathsOptions } from "./testing/index.js";
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
      { type: "xstate.done.actor", actorId: "a1", output: { id: "a1", ran: true } },
      { type: "xstate.done.actor", actorId: "a2", output: { id: "a2", ran: true } },
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
      // SAW_X and SAW_Y come only from the picker.
      hostEvents: [],
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

  describe("review regressions", () => {
    // G answers PING with PONG to its parent K.
    const g = createMachine({
      initial: "on",
      states: {
        on: {
          on: {
            PING: ({ parent }: { parent?: unknown }, enq: Enq) =>
              void tell("PONG")({ parent }, enq),
          },
        },
      },
    } as never) as AnyStateMachine;
    // K pings G on the host's X; with `alsoTell` it also reports A to its parent.
    const createK = (alsoTell: boolean) =>
      setupAgent({
        context: z.object({}),
        events: { X: z.object({}), PONG: z.object({}), ABORT: z.object({}) },
        actors: { g },
      }).createMachine({
        context: {},
        invoke: { id: "g", src: "g" },
        initial: "a",
        states: {
          a: {
            on: {
              X: ({ children, parent }, enq) => {
                enq.sendTo(children["g"] as never, { type: "PING" });
                if (alsoTell && parent) enq.sendTo(parent as never, { type: "A" } as never);
                return { target: "b" };
              },
            },
          },
          b: {
            on: {
              PONG: { target: "c" },
              ABORT: ({ parent }, enq) => {
                if (parent) enq.sendTo(parent as never, { type: "BAD" } as never);
              },
            },
          },
          c: { type: "final" },
        },
      }) as AnyStateMachine;

    test("a grandchild's reply lands in the same move, before the parent's next send", async () => {
      const k = createK(true);
      const machine = setupAgent({
        context: z.object({}),
        events: { A: z.object({}) },
        actors: { k },
      }).createMachine({
        context: {},
        initial: "running",
        states: {
          running: {
            invoke: { id: "k", src: "k", onDone: { target: "goal" } },
            on: {
              A: ({ children }, enq) => {
                enq.sendTo(children["k"] as never, { type: "Z" });
                return {};
              },
            },
          },
          goal: { type: "final" },
        },
      });
      const result = await canReach(machine, "goal", {
        children: "coupled",
        childEvents: { k: ["X"] },
        hostEvents: [],
      });
      expect(result).toMatchObject({ reachable: true, complete: true });
    });

    test("no host event fits between a child's move and its grandchild's reply", async () => {
      const k = createK(false);
      const machine = setupAgent({
        context: z.object({}),
        events: { GO: z.object({}), BAD: z.object({}) },
        actors: { k },
      }).createMachine({
        context: {},
        initial: "running",
        states: {
          running: {
            invoke: { id: "k", src: "k", onDone: { target: "finished" } },
            on: {
              GO: ({ children }, enq) => {
                enq.sendTo(children["k"] as never, { type: "ABORT" });
                return {};
              },
              BAD: { target: "bad" },
            },
          },
          bad: { type: "final" },
          finished: { type: "final" },
        },
      });
      const result = await canReach(machine, "bad", {
        children: "coupled",
        childEvents: { k: ["X"] },
        hostEvents: ["GO"],
        interleave: "pending",
        // GO can repeat forever; equal states are explored once.
        dedupeBy: (snapshot) => JSON.stringify(snapshot.value),
      });
      expect(result).toMatchObject({ reachable: false, complete: true });
    });

    test("a child's send to a sibling is delivered", async () => {
      const b = createMachine({
        initial: "on",
        states: {
          on: {
            on: {
              HI: ({ parent }: { parent?: unknown }, enq: Enq) => void tell("GOT")({ parent }, enq),
            },
          },
        },
      } as never) as AnyStateMachine;
      const a = createMachine({
        context: ({ input }: { input: { peer: unknown } }) => ({ peer: input.peer }),
        initial: "on",
        states: {
          on: {
            on: {
              X: ({ context }: { context: { peer: unknown } }, enq: Enq) => {
                enq.sendTo(context.peer, { type: "HI" });
              },
            },
          },
        },
      } as never) as AnyStateMachine;
      const machine = setupAgent({
        context: z.object({}),
        events: { GOT: z.object({}) },
        actors: { a, b },
      }).createMachine({
        context: {},
        initial: "running",
        states: {
          running: {
            entry: ({ actors }, enq) => {
              const peer = enq.spawn(actors.b, { id: "b" });
              enq.spawn(actors.a, { id: "a", input: { peer } as never });
            },
            on: { GOT: { target: "goal" } },
          },
          goal: { type: "final" },
        },
      });
      const result = await canReach(machine, "goal", {
        children: "coupled",
        childEvents: { a: ["X"] },
        hostEvents: [],
      });
      expect(result).toMatchObject({ reachable: true, complete: true });
    });

    test("while every child waits on the host, the parent's host events can arrive", async () => {
      const kid = createMachine({
        initial: "idle",
        states: { idle: { on: { PING: { target: "done" } } }, done: { type: "final" } },
      } as never) as AnyStateMachine;
      const machine = setupAgent({
        context: z.object({}),
        events: { GO: z.object({}) },
        actors: { kid },
      }).createMachine({
        context: {},
        initial: "running",
        states: {
          running: {
            invoke: { id: "kid", src: "kid", onDone: { target: "finished" } },
            on: { GO: { target: "goal" } },
          },
          goal: { type: "final" },
          finished: { type: "final" },
        },
      });
      const result = await canReach(machine, "goal", {
        children: "coupled",
        childEvents: { kid: ["PING"] },
      });
      expect(result).toMatchObject({ reachable: true, complete: true });
    });
  });

  describe("second review regressions", () => {
    // B reports GOT to its parent when anyone says HI.
    const b = createMachine({
      initial: "on",
      states: {
        on: {
          on: {
            HI: ({ parent }: { parent?: unknown }, enq: Enq) => void tell("GOT")({ parent }, enq),
          },
        },
      },
    } as never) as AnyStateMachine;

    test("a child's entry send to a sibling arrives, though the child stays idle", async () => {
      const a = createMachine({
        context: ({ input }: { input: { peer: unknown } }) => ({ peer: input.peer }),
        initial: "on",
        states: {
          on: {
            entry: ({ context }: { context: { peer: unknown } }, enq: Enq) => {
              enq.sendTo(context.peer, { type: "HI" });
            },
          },
        },
      } as never) as AnyStateMachine;
      const machine = setupAgent({
        context: z.object({}),
        events: { GOT: z.object({}) },
        actors: { a, b },
      }).createMachine({
        context: {},
        initial: "running",
        states: {
          running: {
            entry: ({ actors }, enq) => {
              const peer = enq.spawn(actors.b, { id: "b" });
              enq.spawn(actors.a, { id: "a", input: { peer } as never });
            },
            on: { GOT: { target: "goal" } },
          },
          goal: { type: "final" },
        },
      });
      const result = await canReach(machine, "goal", { children: "coupled", hostEvents: [] });
      expect(result).toMatchObject({ reachable: true, complete: true });
    });

    test("a child's sends to a sibling and to its parent keep their order", async () => {
      // B answers HI with ACK. A, on the host's X, says HI to B, then A_DONE to its parent.
      const bAck = createMachine({
        initial: "on",
        states: {
          on: {
            on: {
              HI: ({ parent }: { parent?: unknown }, enq: Enq) => void tell("ACK")({ parent }, enq),
            },
          },
        },
      } as never) as AnyStateMachine;
      const a = createMachine({
        context: ({ input }: { input: { peer: unknown } }) => ({ peer: input.peer }),
        initial: "on",
        states: {
          on: {
            on: {
              X: (
                { context, parent }: { context: { peer: unknown }; parent?: unknown },
                enq: Enq,
              ) => {
                enq.sendTo(context.peer, { type: "HI" });
                if (parent) enq.sendTo(parent, { type: "A_DONE" });
              },
            },
          },
        },
      } as never) as AnyStateMachine;
      const machine = setupAgent({
        context: z.object({ acked: z.boolean() }),
        events: { ACK: z.object({}), A_DONE: z.object({}) },
        actors: { a, b: bAck },
      }).createMachine({
        context: { acked: false },
        initial: "running",
        states: {
          running: {
            entry: ({ actors }, enq) => {
              const peer = enq.spawn(actors.b, { id: "b" });
              enq.spawn(actors.a, { id: "a", input: { peer } as never });
            },
            on: {
              ACK: { context: { acked: true } },
              A_DONE: ({ context }) => ({ target: context.acked ? "goal" : "early" }),
            },
          },
          goal: { type: "final" },
          early: { type: "final" },
        },
      });
      const options = {
        children: "coupled" as const,
        childEvents: { a: ["X"] },
        hostEvents: [],
        payloads: () => ({ X: [{}] }),
      };
      expect(await canReach(machine, "goal", options)).toMatchObject({
        reachable: true,
        complete: true,
      });
      expect(await canReach(machine, "early", options)).toMatchObject({
        reachable: false,
        complete: true,
      });
    });

    test("a grandchild waiting on the host leaves the root's host events open", async () => {
      const leaf = createMachine({
        initial: "idle",
        states: { idle: { on: { PING: { target: "done" } } }, done: { type: "final" } },
      } as never) as AnyStateMachine;
      const middle = setupAgent({ context: z.object({}), actors: { leaf } }).createMachine({
        context: {},
        initial: "waiting",
        states: {
          waiting: { invoke: { id: "leaf", src: "leaf", onDone: { target: "done" } } },
          done: { type: "final" },
        },
      }) as AnyStateMachine;
      const machine = setupAgent({
        context: z.object({}),
        events: { CANCEL: z.object({}) },
        actors: { middle },
      }).createMachine({
        context: {},
        initial: "running",
        states: {
          running: {
            invoke: { id: "middle", src: "middle", onDone: { target: "finished" } },
            on: { CANCEL: { target: "cancelled" } },
          },
          cancelled: { type: "final" },
          finished: { type: "final" },
        },
      });
      const result = await canReach(machine, "cancelled", {
        children: "coupled",
        childEvents: { leaf: ["PING"] },
      });
      expect(result).toMatchObject({ reachable: true, complete: true });
      // The grandchild's host event is labeled with its path of actors.
      const finished = await canReach(machine, "finished", {
        children: "coupled",
        childEvents: { leaf: ["PING"] },
      });
      expect(finished.witness).toContainEqual({ type: "PING", actor: "middle.leaf" });
    });
  });
});

describe("coupled child snapshots in predicates", () => {
  const counter = setupAgent({
    context: z.object({ n: z.number() }),
    events: { PING: z.object({}) },
  }).createMachine({
    context: { n: 0 },
    initial: "a",
    states: {
      a: { on: { PING: ({ context }) => ({ target: "b", context: { n: context.n + 1 } }) } },
      b: {},
    },
  });

  const pinger = setupAgent({
    context: z.object({ sent: z.number() }),
    events: { GO: z.object({}) },
    actors: { counter },
  }).createMachine({
    context: { sent: 0 },
    entry: ({ actors }, enq) => {
      enq.spawn(actors.counter, { id: "c" });
    },
    on: {
      GO: ({ context, children }, enq) => {
        if (context.sent > 0) return undefined;
        enq.sendTo(children.c, { type: "PING" });
        return { context: { sent: context.sent + 1 } };
      },
    },
  });

  const childState = (snapshot: any, id: string) => snapshot.children[id]?.getSnapshot();

  test("a coupled predicate sees the child's explored state", async () => {
    const seen = new Set<unknown>();
    const reached = await canReach(
      pinger,
      (snapshot) => {
        seen.add(childState(snapshot, "c")?.value);
        return childState(snapshot, "c")?.value === "b";
      },
      { children: "coupled", maxDepth: 3 },
    );
    expect(reached.reachable).toBe(true);
    expect(reached.witness).toEqual([{ type: "GO" }]);
    expect(seen).toEqual(new Set(["a", "b"]));
  });

  test("a parent send and the child's receipt are one state to a predicate", async () => {
    // sent === child n on every explored state: the send applies at once.
    const broken = await canReach(
      pinger,
      (snapshot) => snapshot.context.sent !== childState(snapshot, "c")?.context.n,
      { children: "coupled", maxDepth: 3 },
    );
    expect(broken.reachable).toBe(false);
  });

  const stepper = setupAgent({ events: { GO: z.object({}) }, context: z.object({}) }).createMachine(
    {
      context: {},
      initial: "a",
      states: {
        a: { on: { GO: { target: "b" } } },
        b: { on: { GO: { target: "c" } } },
        c: { type: "final" },
      },
    },
  );

  const host = setupAgent({ events: {}, context: z.object({}), actors: { stepper } }).createMachine(
    {
      context: {},
      initial: "running",
      states: {
        running: { invoke: { id: "kid", src: "stepper", onDone: { target: "done" } } },
        done: { type: "final" },
      },
    },
  );

  test("a predicate sees an invoked child's own moves", async () => {
    const reached = await canReach(host, (snapshot) => childState(snapshot, "kid")?.value === "b", {
      children: "coupled",
      childEvents: { stepper: ["GO"] },
    });
    expect(reached.reachable).toBe(true);
    expect(reached.witness).toEqual([{ type: "GO", actor: "kid" }]);
  });

  test("dedupeBy sees the coupled child's explored state", async () => {
    const keys = new Set<string>();
    await explorePaths(host, {
      children: "coupled",
      childEvents: { stepper: ["GO"] },
      dedupeBy: (snapshot) => {
        const key = `${JSON.stringify(snapshot.value)}:${String(childState(snapshot, "kid")?.value)}`;
        keys.add(key);
        return key;
      },
    });
    expect(keys).toEqual(new Set(['"running":a', '"running":b', '"done":undefined']));
  });
});

describe("coupled child usage", () => {
  const workerAgent = setupAgent({
    context: z.object({}),
    events: {},
    requests: {
      summarize: { model: "m", schemas: { input: z.object({}), output: z.string() }, prompt: "x" },
    },
  });
  const worker = workerAgent.createMachine({
    context: {},
    initial: "working",
    states: {
      working: { invoke: { id: "s", src: "summarize", input: {}, onDone: { target: "done" } } },
      done: { type: "final" },
    },
  });
  // A token budget the child's request feeds: the root is charged, as in a run.
  const createBudget = (onUsage?: (event: unknown) => void) =>
    setupAgent({
      context: z.object({ tokens: z.number() }),
      events: {},
      actors: { worker },
    }).createMachine({
      context: { tokens: 0 },
      initial: "running",
      states: {
        running: {
          on: {
            [AGENT_USAGE_EVENT_TYPE]: ({ context, event }) => {
              onUsage?.(event);
              const tokens = context.tokens + (event.usage.totalTokens ?? 0);
              return tokens > 100
                ? { target: "overBudget", context: { tokens } }
                : { context: { tokens } };
            },
          },
          invoke: { id: "w", src: "worker", onDone: { target: "done" } },
        },
        overBudget: { type: "final" },
        done: { type: "final" },
      },
    });
  const usageEvent = (totalTokens: number) => ({
    type: AGENT_USAGE_EVENT_TYPE,
    kind: "text",
    id: "s",
    src: "summarize",
    model: "m",
    name: "summarize",
    usage: { totalTokens },
  });
  const options: ExplorePathsOptions = {
    children: "coupled",
    outputs: { summarize: ["ok"] },
    usage: { summarize: [{ totalTokens: 10 }, { totalTokens: 500 }] },
  };

  test("a child request's usage is delivered to the root before its completion", async () => {
    const report = await explorePaths(createBudget(), options);
    expect(report.complete).toBe(true);
    expect(report.terminals).toEqual([
      {
        status: "done",
        path: [
          { type: "xstate.done.actor", actorId: "s", output: "ok", actor: "w" },
          usageEvent(10),
          { type: "xstate.done.actor", actorId: "w" },
        ],
        state: "done",
      },
      {
        status: "done",
        path: [
          { type: "xstate.done.actor", actorId: "s", output: "ok", actor: "w" },
          usageEvent(500),
        ],
        state: "overBudget",
      },
    ]);
    expect(
      await canReach(createBudget(), (snapshot) => snapshot.context.tokens > 100, options),
    ).toMatchObject({ reachable: true });
  });

  test("the root drops usage it does not take", async () => {
    const plain = setupAgent({
      context: z.object({}),
      events: {},
      actors: { worker },
    }).createMachine({
      context: {},
      initial: "running",
      states: {
        running: { invoke: { id: "w", src: "worker", onDone: { target: "done" } } },
        done: { type: "final" },
      },
    });
    const report = await explorePaths(plain, options);
    expect(report.complete).toBe(true);
    expect(report.vacuous).toEqual([]);
    for (const terminal of report.terminals) {
      expect(terminal.path.map((event) => event.type)).not.toContain(AGENT_USAGE_EVENT_TYPE);
      expect(terminal.state).toBe("done");
    }
  });

  test("a run charges the root with the same event, bar its budget and call key", async () => {
    const seen: unknown[] = [];
    const run = await runAgent(
      createBudget((event) => seen.push(event)),
      { executors: { generateText: async () => ({ result: "ok", usage: { totalTokens: 10 } }) } },
    );
    expect(run.status).toBe("done");
    const { budget: _budget, callKey: _callKey, ...live } = seen[0] as Record<string, unknown>;
    expect(live).toEqual(usageEvent(10));
  });
});
