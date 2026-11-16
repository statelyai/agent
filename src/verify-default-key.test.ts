import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createAsyncLogic, createMachine, type AnyStateMachine } from "xstate";
import { setupAgent } from "./index.js";
import { canReach, explorePaths } from "./testing/index.js";

// A loop of up to three turns the host can PAUSE, RESUME, and STOP while a
// turn runs. With `honorStop: false`, a stopped loop starts another turn.
function createPausableLoop({ honorStop = true } = {}) {
  const agent = setupAgent({
    context: z.object({ turns: z.number(), paused: z.boolean(), stopped: z.boolean() }),
    events: { PAUSE: z.object({}), RESUME: z.object({}), STOP: z.object({}) },
    actors: {
      turn: createAsyncLogic<{ ok: boolean }>({ run: async () => ({ ok: true }) }),
    },
  });
  const flags = {
    PAUSE: ({ context }: { context: { turns: number; paused: boolean; stopped: boolean } }) => ({
      context: { ...context, paused: true },
    }),
    RESUME: ({ context }: { context: { turns: number; paused: boolean; stopped: boolean } }) => ({
      context: { ...context, paused: false },
    }),
    STOP: ({ context }: { context: { turns: number; paused: boolean; stopped: boolean } }) => ({
      context: { ...context, stopped: true },
    }),
  };
  return agent.createMachine({
    context: { turns: 0, paused: false, stopped: false },
    initial: "running",
    states: {
      running: {
        invoke: {
          src: "turn",
          onDone: ({ context }) => ({
            target: "checking",
            context: { ...context, turns: context.turns + 1 },
          }),
        },
        on: flags,
      },
      checking: {
        type: "choice",
        choice: ({ context }) =>
          honorStop && context.stopped
            ? { target: "stopped" }
            : context.turns >= 3
              ? { target: "finished" }
              : context.paused
                ? { target: "paused" }
                : { target: "running" },
      },
      paused: { on: { ...flags, RESUME: { target: "checking", context: undefined } } },
      stopped: { type: "final" },
      finished: { type: "final" },
    },
  });
}

const options = {
  outputs: { turn: [{ ok: true }] },
  interleave: "pending" as const,
  maxDepth: 80,
  maxPaths: 100_000,
};
const noTurnAfterStop = {
  after: "STOP",
  reach: (step: { started: string[] }) => step.started.includes("turn"),
};

describe("canReach — default key", () => {
  test("an interleaved search with no dedupeBy finishes and proves the rule", async () => {
    const explored = await explorePaths(createPausableLoop(), { ...options, maxDepth: 8 });
    // Every path in full: the interleavings outgrow the caps.
    expect(explored.complete).toBe(false);

    const started = performance.now();
    const result = await canReach(createPausableLoop(), noTurnAfterStop, options);
    expect(result).toMatchObject({ reachable: false, complete: true });
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  test("still finds the violation a mutant allows", async () => {
    const result = await canReach(
      createPausableLoop({ honorStop: false }),
      noTurnAfterStop,
      options,
    );
    expect(result.reachable).toBe(true);
  });

  test("a loop over finitely many states is a complete search", async () => {
    const loop = createMachine({
      initial: "a",
      states: {
        a: { on: { NEXT: { target: "b" } } },
        b: { on: { NEXT: { target: "a" } } },
        never: {},
      },
    });
    expect(await canReach(loop, "never", { maxDepth: 50 })).toMatchObject({
      reachable: false,
      complete: true,
    });
  });

  test("context that is not plain data is not merged", async () => {
    // JSON writes every Map as `{}`, which would merge these states.
    const machine = createMachine({
      context: { m: new Map<number, number>() },
      initial: "idle",
      states: {
        idle: {
          on: {
            ADD: ({ context }) => ({
              context: { m: new Map([...context.m, [context.m.size, 1]]) },
            }),
          },
        },
      },
    });
    const result = await canReach(machine, (snapshot) => snapshot.context.m.size >= 2, {
      maxDepth: 3,
    });
    expect(result.reachable).toBe(true);
  });

  test("a pending invoke's input is part of the key", async () => {
    // A and B enter `deciding` with equal context; only B's decision can APPROVE.
    const agent = setupAgent({
      context: z.object({}),
      events: { A: z.object({}), B: z.object({}), APPROVE: z.object({}), REJECT: z.object({}) },
    });
    const machine = agent.createMachine({
      context: {},
      initial: "start",
      states: {
        start: { on: { A: { target: "deciding" }, B: { target: "deciding" } } },
        deciding: {
          invoke: {
            id: "review",
            src: "agent.decide",
            input: ({ event }: { event: { type: string } }) => ({
              model: "m",
              prompt: "approve?",
              allowedEvents: event.type === "B" ? (["APPROVE"] as const) : (["REJECT"] as const),
            }),
          },
          on: { APPROVE: { target: "approved" }, REJECT: { target: "rejected" } },
        },
        approved: { type: "final" },
        rejected: { type: "final" },
      },
    });
    expect(await canReach(machine, "approved")).toMatchObject({ reachable: true });
  });

  test("a coupled child's armed timer is part of the key", async () => {
    // ARM schedules TIMEOUT without changing the child's state or context.
    const child = createMachine({
      initial: "waiting",
      states: {
        waiting: {
          on: {
            ARM: (_: unknown, enq: { raise: (event: unknown, options: unknown) => void }) => {
              enq.raise({ type: "TIMEOUT" }, { delay: 50 });
            },
            TIMEOUT: { target: "timedOut" },
          },
        },
        timedOut: { type: "final" },
      },
    } as never) as AnyStateMachine;
    const parent = createMachine({
      initial: "running",
      states: {
        running: { invoke: { id: "child", src: child, onDone: { target: "expired" } } },
        expired: { type: "final" },
      },
    } as never) as AnyStateMachine;
    const result = await canReach(parent, "expired", {
      children: "coupled",
      childEvents: { child: ["ARM"] },
    });
    expect(result.reachable).toBe(true);
  });

  test("a sparse array is not merged with a shorter one", async () => {
    const machine = createMachine({
      context: { items: [] as unknown[] },
      initial: "waiting",
      states: {
        waiting: {
          on: {
            KEEP: { context: { items: [] } },
            HOLE: { context: { items: new Array(1) } },
            GO: ({ context }) => (context.items.length === 1 ? { target: "goal" } : undefined),
          },
        },
        goal: { type: "final" },
      },
    });
    expect(await canReach(machine, "goal", { maxDepth: 3 })).toMatchObject({ reachable: true });
  });

  test("a sparse array with an extra property is not merged with an empty one", async () => {
    // One hole and one extra property: as many own keys as its length.
    const machine = createMachine({
      context: { items: [] as unknown[] },
      initial: "waiting",
      states: {
        waiting: {
          on: {
            TAGGED: { context: { items: Object.assign(new Array(1), { tag: true }) } },
            GO: ({ context }) => (context.items.length === 1 ? { target: "goal" } : undefined),
          },
        },
        goal: { type: "final" },
      },
    });
    expect(await canReach(machine, "goal", { maxDepth: 3 })).toMatchObject({ reachable: true });
  });

  test("a symbol-keyed property is not dropped from the key", async () => {
    const token = Symbol("flag");
    const machine = createMachine({
      context: { flag: { [token]: false } as Record<symbol, boolean> },
      initial: "waiting",
      states: {
        waiting: {
          on: {
            FLIP: { context: { flag: { [token]: true } } },
            GO: ({ context }) => (context.flag[token] ? { target: "goal" } : undefined),
          },
        },
        goal: { type: "final" },
      },
    });
    expect(await canReach(machine, "goal", { maxDepth: 3 })).toMatchObject({ reachable: true });
  });

  test("key order is part of the key", async () => {
    const machine = createMachine({
      context: { queue: { a: 0, b: 0 } as Record<string, number> },
      initial: "waiting",
      states: {
        waiting: {
          on: {
            REORDER: { context: { queue: { b: 0, a: 0 } } },
            GO: ({ context }) =>
              Object.keys(context.queue)[0] === "b" ? { target: "goal" } : undefined,
          },
        },
        goal: { type: "final" },
      },
    });
    expect(await canReach(machine, "goal", { maxDepth: 3 })).toMatchObject({ reachable: true });
  });

  test("negative zero is not merged with zero", async () => {
    const machine = createMachine({
      context: { n: 0 },
      initial: "waiting",
      states: {
        waiting: {
          on: {
            FLIP: { context: { n: -0 } },
            GO: ({ context }) => (Object.is(context.n, -0) ? { target: "goal" } : undefined),
          },
        },
        goal: { type: "final" },
      },
    });
    expect(await canReach(machine, "goal", { maxDepth: 3 })).toMatchObject({ reachable: true });
  });
});
