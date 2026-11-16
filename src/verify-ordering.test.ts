import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createAsyncLogic, createMachine } from "xstate";
import { setupAgent } from "./index.js";
import { canReach, explorePaths, type CanReachOrdering } from "./testing/index.js";

// A loop of turns the host can STOP. The turn in flight finishes; with
// `honorStop: false`, the loop starts another one anyway.
function createTurnLoop({ honorStop = true } = {}) {
  const agent = setupAgent({
    context: z.object({ turns: z.number(), stopped: z.boolean() }),
    actors: {
      turn: createAsyncLogic<{ kind: string }>({ run: async () => ({ kind: "continue" }) }),
    },
  });
  return agent.createMachine({
    context: { turns: 0, stopped: false },
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
        // STOP arrives once; the turn in flight keeps running.
        on: {
          STOP: ({ context }) =>
            context.stopped ? undefined : { context: { ...context, stopped: true } },
        },
      },
      checking: {
        type: "choice",
        choice: ({ context }) =>
          honorStop && context.stopped
            ? { target: "stopped" }
            : context.turns >= 2
              ? { target: "finished" }
              : { target: "running" },
      },
      stopped: { type: "final" },
      finished: { type: "final" },
    },
  });
}

const noTurnAfterStop: CanReachOrdering = {
  after: "STOP",
  reach: (step) => step.started.includes("turn"),
};

// One canned output per src: no invoke forks, so `path` holds only STOP.
const options = {
  outputs: { turn: [{ kind: "continue" }] },
  interleave: "pending" as const,
  payloads: () => ({ STOP: [{}] }),
};

describe("explorePaths — steps", () => {
  test("records every macrostep with the srcs it started and settled", async () => {
    const report = await explorePaths(createTurnLoop(), { ...options, steps: true });
    const plain = report.terminals.find((terminal) => terminal.path.length === 0)!;
    expect(plain.steps!.map((step) => [step.event.type, step.started, step.settled])).toEqual([
      ["xstate.init", ["turn"], []],
      ["xstate.done.actor", ["turn"], ["turn"]],
      ["xstate.done.actor", [], ["turn"]],
    ]);
    expect(plain.steps!.at(-1)!.state).toBe("finished");
  });

  test("is off by default", async () => {
    const report = await explorePaths(createTurnLoop(), options);
    expect(report.terminals.every((terminal) => terminal.steps === undefined)).toBe(true);
  });
});

describe("canReach — ordering target", () => {
  test("proves no turn starts after STOP; the turn in flight does not count", async () => {
    const result = await canReach(createTurnLoop(), noTurnAfterStop, options);
    expect(result).toMatchObject({ reachable: false, complete: true });
  });

  test("catches a loop that starts a turn after STOP, which `path` does not show", async () => {
    const mutant = createTurnLoop({ honorStop: false });
    const result = await canReach(mutant, noTurnAfterStop, options);
    expect(result).toMatchObject({ reachable: true, witness: [{ type: "STOP" }] });
    // The blind spot: no path lists the turn the mutant started after STOP.
    const report = await explorePaths(mutant, { ...options, steps: true });
    const stopFirst = report.terminals.find(
      (terminal) => terminal.path.length === 1 && terminal.steps![1]!.event.type === "STOP",
    )!;
    expect(stopFirst.path).toEqual([{ type: "STOP" }]);
    expect(stopFirst.steps!.slice(2).some((step) => step.started.includes("turn"))).toBe(true);
  });

  test("`reach` is not checked on the `after` step itself", async () => {
    const agent = setupAgent({
      context: z.object({}),
      actors: { cleanup: createAsyncLogic<null>({ run: async () => null }) },
    });
    const machine = agent.createMachine({
      context: {},
      initial: "waiting",
      states: {
        waiting: { on: { STOP: { target: "cleaning" } } },
        cleaning: { invoke: { src: "cleanup", onDone: { target: "done" } } },
        done: { type: "final" },
      },
    });
    const ordering = {
      after: "STOP",
      reach: (step: { started: string[] }) => step.started.includes("cleanup"),
    };
    const opts = { outputs: { cleanup: [null] }, payloads: () => ({ STOP: [{}] }) };
    expect(await canReach(machine, ordering, opts)).toMatchObject({
      reachable: false,
      complete: true,
    });
    expect(
      await canReach(
        machine,
        { after: (step) => step.state === "waiting", reach: ordering.reach },
        opts,
      ),
    ).toMatchObject({ reachable: true });
  });

  test("stays sound with dedupeBy when the trigger leaves the snapshot unchanged", async () => {
    const agent = setupAgent({
      context: z.object({ stopped: z.boolean() }),
      actors: { turn: createAsyncLogic<null>({ run: async () => null }) },
    });
    // The key below leaves out `stopped`: nothing branches on it.
    const machine = agent.createMachine({
      context: { stopped: false },
      initial: "waiting",
      states: {
        waiting: {
          on: {
            STOP: ({ context }) => (context.stopped ? undefined : { context: { stopped: true } }),
            GO: { target: "running" },
          },
        },
        running: { invoke: { src: "turn", onDone: { target: "done" } } },
        done: { type: "final" },
      },
    });
    const result = await canReach(machine, noTurnAfterStop, {
      outputs: { turn: [null] },
      payloads: () => ({ STOP: [{}], GO: [{}] }),
      dedupeBy: (snapshot) => JSON.stringify(snapshot.value),
    });
    expect(result).toMatchObject({ reachable: true, witness: [{ type: "STOP" }, { type: "GO" }] });
  });

  test("a timer that delivers the trigger counts as the trigger", async () => {
    const agent = setupAgent({
      context: z.object({}),
      events: { STOP: z.object({}), GO: z.object({}) },
      actors: { turn: createAsyncLogic<null>({ run: async () => null }) },
    });
    const machine = agent.createMachine({
      context: {},
      initial: "waiting",
      states: {
        waiting: {
          entry: (_, enq) => {
            enq.raise({ type: "STOP" }, { delay: 50 });
          },
          on: { STOP: { target: "stopping" } },
        },
        stopping: { on: { GO: { target: "running" } } },
        running: { invoke: { src: "turn", onDone: { target: "done" } } },
        done: { type: "final" },
      },
    });
    const result = await canReach(machine, noTurnAfterStop, {
      outputs: { turn: [null] },
      hostEvents: ["GO"],
    });
    expect(result).toMatchObject({ reachable: true, witness: [{ type: "STOP" }, { type: "GO" }] });
  });

  test("an event with no schema is unexpanded: the target may read its payload", async () => {
    const agent = setupAgent({
      context: z.object({}),
      actors: { turn: createAsyncLogic<null>({ run: async () => null }) },
    });
    const machine = agent.createMachine({
      context: {},
      initial: "waiting",
      states: {
        waiting: { on: { SEND: { target: "running" } } },
        running: { invoke: { src: "turn", onDone: { target: "done" } } },
        done: { type: "final" },
      },
    });
    const toAdmin: CanReachOrdering = {
      after: "xstate.init",
      reach: (step) => step.event.type === "SEND" && (step.event as { to?: string }).to === "admin",
    };
    const bare = await canReach(machine, toAdmin, { outputs: { turn: [null] } });
    expect(bare).toMatchObject({ reachable: false, complete: false });
    expect(bare.unexplored!.join("\n")).toContain("the ordering target may read its payload");
    const listed = await canReach(machine, toAdmin, {
      outputs: { turn: [null] },
      payloads: () => ({ SEND: [{ to: "user" }, { to: "admin" }] }),
    });
    expect(listed).toMatchObject({ reachable: true, witness: [{ type: "SEND", to: "admin" }] });
  });

  test("with children: 'coupled', a started child machine is named by its src", async () => {
    const worker = createMachine({
      initial: "working",
      states: { working: { on: { END: { target: "finished" } } }, finished: { type: "final" } },
    });
    const parent = createMachine({
      initial: "delegating",
      states: {
        delegating: { invoke: { src: worker, id: "worker", onDone: { target: "done" } } },
        done: { type: "final" },
      },
    });
    const report = await explorePaths(parent, {
      children: "coupled",
      childEvents: { worker: ["END"] },
      steps: true,
    });
    expect(report.terminals[0]!.steps!.map((step) => [step.started, step.settled])).toEqual([
      [["worker"], []],
      [[], ["worker"]],
    ]);
  });
});
