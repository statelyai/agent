import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createAsyncLogic, createMachine, type AnyStateMachine } from "xstate";
import { setupAgent } from "./index.js";
import { canReach, explorePaths } from "./testing/index.js";
import { isExplorationComplete } from "./verify.js";

// A lookup the host can cancel while it is still running.
function createCancellableMachine() {
  const agent = setupAgent({
    context: z.object({}),
    actors: {
      lookup: createAsyncLogic<{ found: boolean }>({ run: async () => ({ found: true }) }),
    },
  });
  return agent.createMachine({
    context: {},
    initial: "working",
    states: {
      working: {
        invoke: { id: "lookup", src: "lookup", onDone: { target: "found" } },
        on: { CANCEL: { target: "cancelled" } },
      },
      found: { type: "final" },
      cancelled: { type: "final" },
    },
  });
}

describe("explorePaths — interleave", () => {
  test("default 'idle': an event racing a resolved invoke is never explored", async () => {
    const options = { outputs: { lookup: [{ found: true }] } };
    const report = await explorePaths(createCancellableMachine(), options);
    expect(report.terminals).toEqual([{ status: "done", path: [], state: "found" }]);
    const result = await canReach(createCancellableMachine(), "cancelled", options);
    expect(result).toMatchObject({ reachable: false, complete: true });
  });

  test("'pending' forks each accepted event before the invoke settles", async () => {
    const options = { outputs: { lookup: [{ found: true }] }, interleave: "pending" as const };
    const report = await explorePaths(createCancellableMachine(), options);
    expect(report.terminals).toEqual([
      { status: "done", path: [], state: "found" },
      { status: "done", path: [{ type: "CANCEL" }], state: "cancelled" },
    ]);
    const { reachable, witness } = await canReach(createCancellableMachine(), "cancelled", options);
    expect(reachable).toBe(true);
    expect(witness).toEqual([{ type: "CANCEL" }]);
  });

  test("races at output forks and needs-output blocks too", async () => {
    const forked = await explorePaths(createCancellableMachine(), {
      outputs: { lookup: [{ found: true }, { found: false }] },
      interleave: "pending",
    });
    expect(forked.terminals.map((t) => t.state)).toEqual(["found", "found", "cancelled"]);

    const blocked = await explorePaths(createCancellableMachine(), { interleave: "pending" });
    expect(blocked.terminals).toEqual([
      { status: "needs-output", path: [], state: "working", missingSrc: "lookup" },
      { status: "done", path: [{ type: "CANCEL" }], state: "cancelled" },
    ]);
  });

  test("each race counts against maxDepth", async () => {
    const report = await explorePaths(createCancellableMachine(), {
      outputs: { lookup: [{ found: true }] },
      interleave: "pending",
      maxDepth: 0,
    });
    expect(report.terminals).toEqual([{ status: "max-depth", path: [], state: "working" }]);
  });

  test("a decision races the events it does not offer", async () => {
    const agent = setupAgent({
      context: z.object({}),
      events: { PICK: z.object({}), CANCEL: z.object({}) },
    });
    const machine = agent.createMachine({
      context: {},
      initial: "deciding",
      states: {
        deciding: {
          invoke: {
            id: "decide",
            src: "agent.decide",
            input: () => ({ model: "quick", prompt: "pick", allowedEvents: ["PICK"] as const }),
          },
          on: { PICK: { target: "picked" }, CANCEL: { target: "cancelled" } },
        },
        picked: { type: "final" },
        cancelled: { type: "final" },
      },
    });
    const idle = await explorePaths(machine);
    expect(idle.terminals.map((t) => t.state)).toEqual(["picked"]);
    const pending = await explorePaths(machine, { interleave: "pending" });
    expect(pending.terminals.map((t) => t.path)).toEqual([
      [{ type: "PICK" }],
      [{ type: "CANCEL" }],
    ]);
  });
});

function createParsingMachine() {
  const agent = setupAgent({
    context: z.object({}),
    actors: { parse: createAsyncLogic<{ total: number }>({ run: async () => ({ total: 1 }) }) },
  });
  return agent.createMachine({
    context: {},
    initial: "parsing",
    states: {
      parsing: {
        invoke: {
          id: "parse",
          src: "parse",
          onDone: { target: "parsed" },
          onError: ({ event }) =>
            (event.error as { code?: string } | undefined)?.code === "truncated"
              ? { target: "retrying" }
              : { target: "failed" },
        },
      },
      parsed: { type: "final" },
      retrying: { type: "final" },
      failed: { type: "final" },
    },
  });
}

describe("explorePaths — errors arrays", () => {
  test("an array forks one failing branch per error, each recorded on the path", async () => {
    const report = await explorePaths(createParsingMachine(), {
      errors: { parse: [{ code: "truncated" }, { code: "other" }] },
    });
    expect(report.terminals).toEqual([
      {
        status: "done",
        path: [{ type: "xstate.error.actor.parse", error: { code: "truncated" } }],
        state: "retrying",
      },
      {
        status: "done",
        path: [{ type: "xstate.error.actor.parse", error: { code: "other" } }],
        state: "failed",
      },
    ]);
  });

  test("a single array-valued failure is wrapped; [] is no entry", async () => {
    const wrapped = await explorePaths(createParsingMachine(), { errors: { parse: [[1, 2]] } });
    expect(wrapped.terminals).toEqual([
      {
        status: "done",
        path: [{ type: "xstate.error.actor.parse", error: [1, 2] }],
        state: "failed",
      },
    ]);
    const empty = await explorePaths(createParsingMachine(), { errors: { parse: [] } });
    expect(empty.terminals).toMatchObject([{ status: "needs-output", missingSrc: "parse" }]);
  });

  test("an array forks a decision's failing branches too", async () => {
    const agent = setupAgent({ context: z.object({}), events: { PICK: z.object({}) } });
    const machine = agent.createMachine({
      context: {},
      initial: "deciding",
      states: {
        deciding: {
          invoke: {
            id: "decide",
            src: "agent.decide",
            input: () => ({ model: "quick", prompt: "pick", allowedEvents: ["PICK"] as const }),
            onError: { target: "failed" },
          },
          on: { PICK: { target: "picked" } },
        },
        picked: { type: "final" },
        failed: { type: "final" },
      },
    });
    const report = await explorePaths(machine, { errors: { "agent.decide": ["a", "b"] } });
    expect(report.terminals.map((t) => t.path)).toEqual([
      [{ type: "xstate.error.actor.decide", error: "a" }],
      [{ type: "xstate.error.actor.decide", error: "b" }],
      [{ type: "PICK" }],
    ]);
  });
});

describe("explorePaths — children: 'explore'", () => {
  // The child waits for a host answer, then finishes with it as output.
  const approval = createMachine({
    initial: "asking",
    states: {
      asking: { on: { YES: { target: "yes" }, NO: { target: "no" } } },
      yes: { type: "final", output: { ok: true } },
      no: { type: "final", output: { ok: false } },
    },
  });

  function createParent(child: AnyStateMachine) {
    const agent = setupAgent({ context: z.object({}), actors: { approval: child } });
    return agent.createMachine({
      context: {},
      initial: "waiting",
      states: {
        waiting: {
          invoke: {
            id: "approval",
            src: "approval",
            onDone: ({ output }) =>
              (output as { ok: boolean }).ok ? { target: "approved" } : { target: "rejected" },
            onError: { target: "failed" },
          },
        },
        approved: { type: "final" },
        rejected: { type: "final" },
        failed: { type: "final" },
      },
    });
  }

  test("default 'outputs': a child machine is a needs-output block", async () => {
    const report = await explorePaths(createParent(approval));
    expect(report.terminals).toMatchObject([{ status: "needs-output", missingSrc: "approval" }]);
  });

  test("'explore': a child wait for an event nobody forwards is incomplete, not reachable", async () => {
    // The parent forwards neither YES nor NO, so the child can never finish.
    const report = await explorePaths(createParent(approval), { children: "explore" });
    expect(report.terminals.some((t) => t.status === "done")).toBe(false);
    expect(report.terminals).toMatchObject([
      { status: "idle", state: "waiting" },
      { status: "needs-output", missingSrc: "approval" },
    ]);
    expect(report.unexplored.some((note) => note.includes("childEvents"))).toBe(true);
    expect(isExplorationComplete(report)).toBe(false);
    const result = await canReach(createParent(approval), "rejected", { children: "explore" });
    expect(result).toMatchObject({ reachable: false, complete: false });
  });

  test("'explore': the child's distinct outputs fork the parent", async () => {
    const childEvents = { approval: ["YES", "NO"] };
    const report = await explorePaths(createParent(approval), { children: "explore", childEvents });
    expect(report.terminals).toEqual([
      {
        status: "done",
        path: [{ type: "xstate.done.actor.approval", output: { ok: true } }],
        state: "approved",
      },
      {
        status: "done",
        path: [{ type: "xstate.done.actor.approval", output: { ok: false } }],
        state: "rejected",
      },
    ]);
    expect(isExplorationComplete(report)).toBe(true);
    const { witness } = await canReach(createParent(approval), "rejected", {
      children: "explore",
      childEvents,
    });
    expect(witness).toEqual([{ type: "xstate.done.actor.approval", output: { ok: false } }]);
  });

  test("an outputs entry still wins over exploring the child", async () => {
    const report = await explorePaths(createParent(approval), {
      children: "explore",
      outputs: { approval: [{ ok: true }] },
    });
    expect(report.terminals.map((t) => t.state)).toEqual(["approved"]);
  });

  test("a child error terminal forks the parent's failing branch", async () => {
    const failing = createMachine({
      initial: "calling",
      states: { calling: { invoke: { id: "call", src: "call" } } },
      actors: { call: createAsyncLogic({ run: async () => 1 }) },
    } as never) as AnyStateMachine;
    const error = new Error("down");
    const report = await explorePaths(createParent(failing), {
      children: "explore",
      errors: { call: error },
    });
    expect(report.terminals).toEqual([
      { status: "done", path: [{ type: "xstate.error.actor.approval", error }], state: "failed" },
    ]);
  });

  test("an incomplete child search makes the parent incomplete", async () => {
    const blocked = createMachine({
      initial: "calling",
      states: { calling: { invoke: { id: "call", src: "call" } } },
      actors: { call: createAsyncLogic({ run: async () => 1 }) },
    } as never) as AnyStateMachine;
    const report = await explorePaths(createParent(blocked), { children: "explore" });
    expect(report.terminals).toMatchObject([{ status: "needs-output", missingSrc: "approval" }]);
    expect(isExplorationComplete(report)).toBe(false);
    expect(report.unexplored).toContain(
      "child: exploring src 'approval' was incomplete, so its outputs may be partial; add an outputs entry for it",
    );
  });

  test("a child that can stall leaves the parent idle", async () => {
    const stalling = createMachine({
      initial: "asking",
      states: {
        asking: { on: { YES: { target: "yes" }, WAIT: { target: "stuck" } } },
        stuck: {},
        yes: { type: "final", output: { ok: true } },
      },
    });
    const report = await explorePaths(createParent(stalling), {
      children: "explore",
      childEvents: { approval: ["YES", "WAIT"] },
    });
    expect(report.terminals.map((t) => [t.status, t.state])).toEqual([
      ["done", "approved"],
      ["idle", "waiting"],
    ]);
  });
});

describe("explorePaths — spawned children", () => {
  // Each child pauses for approval, tells its parent READY, then waits for RELEASE.
  const approver = createMachine({
    context: ({ input }: { input: { id: string } }) => ({ id: input.id }),
    initial: "asking",
    states: {
      asking: { on: { APPROVE: { target: "approved" }, REJECT: { target: "rejected" } } },
      approved: {
        entry: (
          { parent }: { parent?: unknown },
          enq: { sendTo: (to: unknown, event: unknown) => void },
        ) => {
          if (parent) enq.sendTo(parent, { type: "READY" });
        },
        on: { RELEASE: { target: "ran" } },
      },
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

  // Spawns two approvers; both READY opens the barrier.
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
            READY: ({ context }) =>
              context.ready + 1 === 2
                ? { target: "released", context: { ready: 2 } }
                : { context: { ready: context.ready + 1 } },
          },
        },
        released: {},
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
  const childEvents = { approver: ["APPROVE", "REJECT", "RELEASE"] };

  test("default 'outputs': a spawned child machine is a needs-output block", async () => {
    const report = await explorePaths(createBatch());
    expect(report.terminals).toMatchObject([{ status: "needs-output", missingSrc: "approver" }]);
  });

  test("'explore': each spawned child is explored with its spawn input", async () => {
    const report = await explorePaths(createBatch(), {
      children: "explore",
      childEvents,
      maxDepth: 10,
      maxPaths: 10_000,
    });
    expect(isExplorationComplete(report)).toBe(true);
    const outputs = report.terminals.flatMap((t) =>
      t.path.flatMap((e) => (e.type.startsWith("xstate.done.actor.") ? [e["output"]] : [])),
    );
    expect(outputs).toContainEqual({ id: "a1", ran: true });
    expect(outputs).toContainEqual({ id: "a2", ran: false });
  });

  test("'explore': a child's sendTo(parent) event forks the parent", async () => {
    const options = { children: "explore" as const, childEvents, maxDepth: 10, maxPaths: 10_000 };
    const report = await explorePaths(createBatch(), options);
    expect(report.reachedStates).toContain("released");
    const { reachable, complete, witness } = await canReach(createBatch(), "released", options);
    expect({ reachable, complete }).toEqual({ reachable: true, complete: true });
    expect(witness).toEqual([{ type: "READY" }, { type: "READY" }]);
  });

  test("'explore': each child's event reaches the parent at most once per path", async () => {
    const report = await explorePaths(createBatch(), {
      children: "explore",
      childEvents,
      maxDepth: 10,
      maxPaths: 10_000,
      dedupeBy: (snapshot) => JSON.stringify([snapshot.value, snapshot.context]),
    });
    expect(isExplorationComplete(report)).toBe(true);
    for (const terminal of report.terminals) {
      expect(terminal.path.filter((e) => e.type === "READY").length).toBeLessThanOrEqual(2);
    }
  });
});

describe("explorePaths — explored children: soundness", () => {
  test("a child can settle before a sibling scripted invoke with an earlier id", async () => {
    const child = createMachine({
      initial: "working",
      states: { working: { on: { FINISH: { target: "finished" } } }, finished: { type: "final" } },
    });
    const agent = setupAgent({
      context: z.object({}),
      actors: { a: createAsyncLogic({ run: async () => 1 }), b: child },
    });
    const machine = agent.createMachine({
      context: {},
      initial: "running",
      states: {
        running: {
          invoke: [
            { id: "a", src: "a", onDone: { target: "done" } },
            { id: "b", src: "b", onDone: { target: "recovered" } },
          ],
        },
        done: { type: "final" },
        recovered: { type: "final" },
      },
    });
    const options = {
      children: "explore" as const,
      childEvents: { b: ["FINISH"] },
      outputs: { a: [1] },
    };
    const result = await canReach(machine, "recovered", options);
    expect(result).toMatchObject({ reachable: true, complete: true });
    expect(await canReach(machine, "done", options)).toMatchObject({ reachable: true });
  });
  test("a child restarted under the same id can send the same event again", async () => {
    const worker = createMachine({
      initial: "starting",
      states: {
        starting: {
          on: { GO: { target: "ready" } },
        },
        ready: {
          entry: (
            { parent }: { parent?: unknown },
            enq: { sendTo: (to: unknown, event: unknown) => void },
          ) => {
            if (parent) enq.sendTo(parent, { type: "READY" });
          },
        },
      },
    } as never) as AnyStateMachine;
    const agent = setupAgent({
      context: z.object({ readies: z.number() }),
      events: { READY: z.object({}) },
      actors: { worker },
    });
    const machine = agent.createMachine({
      context: { readies: 0 },
      initial: "first",
      states: {
        first: {
          invoke: { id: "worker", src: "worker" },
          on: { READY: { target: "second", context: { readies: 1 } } },
        },
        second: {
          invoke: { id: "worker", src: "worker" },
          on: { READY: { target: "done", context: { readies: 2 } } },
        },
        done: { type: "final" },
      },
    });
    const result = await canReach(machine, "done", {
      children: "explore",
      childEvents: { worker: ["GO"] },
    });
    expect(result).toMatchObject({ reachable: true });
    expect(result.witness).toEqual([{ type: "READY" }, { type: "READY" }]);
  });
});

describe("explorePaths — vacuous", () => {
  test("a payload-reading transition explored only as bare { type } is vacuous", async () => {
    const machine = createMachine({
      initial: "idle",
      states: {
        idle: {
          on: {
            SUBMIT: ({ event }) =>
              (event as { ok?: boolean }).ok ? { target: "sent" } : undefined,
          },
        },
        sent: { type: "final" },
      },
    });
    const bare = await explorePaths(machine);
    expect(bare.vacuous).toEqual(["SUBMIT"]);
    expect(bare.unexpandedEvents).toEqual(["SUBMIT"]);
    const covered = await explorePaths(machine, {
      payloads: () => ({ SUBMIT: [{ ok: true }, { ok: false }] }),
    });
    expect(covered.vacuous).toEqual([]);
  });

  test("schema fills: free-form required fields are vacuous, partial or finite fills are not", async () => {
    const agent = setupAgent({
      context: z.object({}),
      events: {
        NAMED: z.object({ name: z.string() }),
        TIER: z.object({ tier: z.enum(["basic", "gold"]), note: z.string().optional() }),
        RATE: z.object({ stars: z.enum(["1", "2"]) }),
        PING: z.object({}),
      },
    });
    const machine = agent.createMachine({
      context: {},
      initial: "idle",
      states: {
        idle: {
          on: {
            NAMED: ({ event }) => (event.name === "x" ? { target: "done" } : undefined),
            TIER: ({ event }) => (event.tier === "gold" ? { target: "done" } : undefined),
            RATE: ({ event }) => (event.stars === "2" ? { target: "done" } : undefined),
            PING: () => ({ target: "done" }),
          },
        },
        done: { type: "final" },
      },
    });
    const report = await explorePaths(machine);
    expect(report.vacuous).toEqual(["NAMED"]);
    expect(report.unexpandedEvents.sort()).toEqual(["NAMED", "TIER"]);
  });
});
