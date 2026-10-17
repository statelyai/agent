import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createAsyncLogic, createMachine } from "xstate";
import { setupAgent } from "./index.js";
import { canReach, explorePaths, simulateAgent } from "./testing/index.js";

// A refund desk in miniature: a decision proposes ISSUE (guarded on the
// payload's amount) or ESCALATE; `checking` is a sentinel monitor that
// re-checks the amount independently and routes a leak to `illegal`.
function createPayoutMachine({
  limit = 100,
  guardLimit = 100,
  payloads = false,
  wildcard = false,
  withholdEscalate = false,
} = {}) {
  const agent = setupAgent({
    context: z.object({ amount: z.number() }),
    events: {
      ISSUE: z.object({ amount: z.number() }),
      ESCALATE: z.object({ reason: z.string() }),
    },
  });
  return agent.createMachine({
    context: { amount: 0 },
    initial: "deciding",
    states: {
      deciding: {
        invoke: {
          id: "decide",
          src: "agent.decide",
          input: () => ({
            model: "quick",
            prompt: "Pay out?",
            ...(wildcard ? {} : { allowedEvents: ["ISSUE", "ESCALATE"] as const }),
            ...(payloads
              ? {
                  payloads: {
                    ISSUE: [{ amount: 40 }, { amount: 400 }],
                    ...(withholdEscalate ? { ESCALATE: [] } : {}),
                  },
                }
              : {}),
          }),
        },
        on: {
          ISSUE: ({ event }) =>
            event.amount > 0 && event.amount <= guardLimit
              ? { target: "checking", context: { amount: event.amount } }
              : undefined,
          ESCALATE: { target: "escalated" },
        },
      },
      checking: {
        type: "choice",
        choice: ({ context }) =>
          context.amount <= limit ? { target: "paid" } : { target: "illegal" },
      },
      paid: { type: "final" },
      illegal: { type: "final" },
      escalated: { type: "final" },
    },
  });
}

const AMOUNTS = [0, 1, 100, 100.01, 500];
const amountPayloads = () => ({ ISSUE: AMOUNTS.map((amount) => ({ amount })) });

describe("explorePaths — payload variants", () => {
  test("without payloads, an amount-guarded transition is always pruned", async () => {
    const machine = createPayoutMachine();
    expect((await canReach(machine, "paid")).reachable).toBe(false);
    const report = await explorePaths(machine);
    expect(report.reachedStates).not.toContain("paid");
    expect(report.prunedByGuard).toBe(1);
  });

  test("with payloads, canReach finds the guarded target with a payload-carrying witness", async () => {
    const machine = createPayoutMachine();
    const { reachable, witness } = await canReach(machine, "paid", { payloads: amountPayloads });
    expect(reachable).toBe(true);
    expect(witness).toEqual([{ type: "ISSUE", amount: 1 }]);

    const report = await explorePaths(machine, { payloads: amountPayloads });
    // 0, 100.01 and 500 are guard-rejected; ESCALATE has no entry, so it stays `{ type }`.
    expect(report.prunedByGuard).toBe(3);
    expect(report.terminals.map((t) => t.path)).toEqual([
      [{ type: "ISSUE", amount: 1 }],
      [{ type: "ISSUE", amount: 100 }],
      [{ type: "ESCALATE" }],
    ]);
  });

  test("a correctly guarded sentinel stays unreachable across every payload", async () => {
    const violation = await canReach(createPayoutMachine(), "illegal", {
      payloads: amountPayloads,
    });
    expect(violation.reachable).toBe(false);
  });

  test("a broken guard is caught, with the leaking payload in the witness", async () => {
    const leak = await canReach(createPayoutMachine({ guardLimit: 1000 }), "illegal", {
      payloads: amountPayloads,
    });
    expect(leak).toMatchObject({
      reachable: true,
      witness: [{ type: "ISSUE", amount: 100.01 }],
    });
  });

  test("the payloads function sees the settled snapshot at each branch point", async () => {
    const seen: unknown[] = [];
    await explorePaths(createPayoutMachine(), {
      payloads: (snapshot) => {
        seen.push(snapshot.value);
        return {};
      },
    });
    expect(seen).toEqual(["deciding"]);
  });

  test("distinct payloads into the same state keep distinct contexts (no collapsing)", async () => {
    const machine = createPayoutMachine();
    const report = await explorePaths(machine, { payloads: amountPayloads });
    expect(report.terminals.filter((t) => t.state === "paid")).toHaveLength(2);
    // Only the second variant sets amount 100; a merge on state value would miss it.
    const hundred = await canReach(
      machine,
      (snapshot) => snapshot.matches("paid") && snapshot.context.amount === 100,
      { payloads: amountPayloads },
    );
    expect(hundred.witness).toEqual([{ type: "ISSUE", amount: 100 }]);
  });
});

describe("explorePaths — decision request options", () => {
  test("a decide input's payloads become the branch set, pruned by guards", async () => {
    const machine = createPayoutMachine({ payloads: true });
    const report = await explorePaths(machine);
    expect(report.terminals.map((t) => t.path)).toEqual([
      [{ type: "ISSUE", amount: 40 }],
      [{ type: "ESCALATE" }],
    ]);
    expect(report.prunedByGuard).toBe(1);
  });

  test("an empty payload list on the decide input withholds that event, as at run time", async () => {
    const report = await explorePaths(
      createPayoutMachine({ payloads: true, withholdEscalate: true }),
    );
    expect(report.terminals.map((t) => t.path)).toEqual([[{ type: "ISSUE", amount: 40 }]]);
  });

  test("omitted allowedEvents: options are rebuilt over the snapshot's candidates", async () => {
    const report = await explorePaths(createPayoutMachine({ payloads: true, wildcard: true }));
    expect(report.terminals.map((t) => t.path)).toEqual([
      [{ type: "ISSUE", amount: 40 }],
      [{ type: "ESCALATE" }],
    ]);
  });

  test("simulateAgent rejects a scripted choice outside the offered options, then retries", async () => {
    const result = await simulateAgent(createPayoutMachine({ payloads: true }), {
      script: {
        decisions: {
          "agent.decide": [
            { type: "ISSUE", amount: 50 }, // guard-legal, but not an offered option
            { type: "ISSUE", amount: 40 },
          ],
        },
      },
    });
    expect(result.snapshot.value).toBe("paid");
    expect(result.trail.at(-1)?.rejectedEvents).toEqual([{ type: "ISSUE", amount: 50 }]);
  });

  test("explorer payloads for the same type override the request options", async () => {
    const machine = createPayoutMachine({ payloads: true });
    const { reachable } = await canReach(machine, "paid", {
      payloads: () => ({ ISSUE: [{ amount: 400 }] }),
    });
    expect(reachable).toBe(false);
  });
});

describe("explorePaths — finite-domain payload fill from event schemas", () => {
  function createTierMachine() {
    const agent = setupAgent({
      context: z.object({}),
      events: {
        SET_TIER: z.object({
          tier: z.enum(["basic", "gold"]),
          confirmed: z.boolean(),
          note: z.string().optional(),
        }),
        RATE: z.object({ stars: z.enum(["1", "2", "3", "4", "5", "6", "7", "8", "9"]) }),
        WIDE: z.object({
          a: z.enum(["1", "2", "3", "4", "5", "6", "7", "8", "9"]),
          b: z.enum(["1", "2", "3", "4", "5", "6", "7", "8", "9"]),
        }),
        NAMED: z.object({ name: z.string() }),
      },
    });
    return agent.createMachine({
      context: {},
      initial: "idle",
      states: {
        idle: {
          on: {
            SET_TIER: ({ event }) =>
              event.tier === "gold" && event.confirmed ? { target: "gold" } : undefined,
            RATE: ({ event }) => (event.stars === "7" ? { target: "rated" } : undefined),
            WIDE: ({ event }) =>
              event.a === "9" && event.b === "9" ? { target: "wide" } : undefined,
            NAMED: ({ event }) => (event.name === "x" ? { target: "named" } : undefined),
          },
        },
        gold: { type: "final" },
        rated: { type: "final" },
        wide: { type: "final" },
        named: { type: "final" },
      },
    });
  }

  test("enum and boolean required fields expand to their product with no payloads option", async () => {
    const { reachable, witness } = await canReach(createTierMachine(), "gold");
    expect(reachable).toBe(true);
    expect(witness).toEqual([{ type: "SET_TIER", tier: "gold", confirmed: true }]);
    expect((await canReach(createTierMachine(), "rated")).witness).toEqual([
      { type: "RATE", stars: "7" },
    ]);
  });

  test("a product over the cap, or a free-form field, stays `{ type }`", async () => {
    const report = await explorePaths(createTierMachine());
    expect(report.reachedStates).not.toContain("wide"); // 9 × 9 = 81 > 64
    expect(report.reachedStates).not.toContain("named"); // string: not finite
    // SET_TIER: 3 of 4 combinations rejected; RATE: 8 of 9; WIDE and NAMED: 1 each.
    expect(report.prunedByGuard).toBe(3 + 8 + 1 + 1);
  });
});

test("explorePaths fills finite payloads from a plain machine's own event schemas", async () => {
  // Plain xstate `createMachine`: no setupAgent, so no registered schemas.
  const machine = createMachine({
    schemas: { events: { SET_TIER: z.object({ tier: z.enum(["basic", "gold"]) }) } },
    initial: "idle",
    states: {
      idle: {
        on: { SET_TIER: ({ event }) => (event.tier === "gold" ? { target: "gold" } : undefined) },
      },
      gold: { type: "final" },
    },
  });
  const { reachable, witness } = await canReach(machine, "gold");
  expect(reachable).toBe(true);
  expect(witness).toEqual([{ type: "SET_TIER", tier: "gold" }]);
});

describe("explorePaths — invoke outcome branching", () => {
  function createLookupMachine() {
    const agent = setupAgent({
      context: z.object({}),
      actors: {
        lookup: createAsyncLogic<{ found: boolean }>({ run: async () => ({ found: true }) }),
      },
    });
    return agent.createMachine({
      context: {},
      initial: "lookingUp",
      states: {
        lookingUp: {
          invoke: {
            id: "lookup",
            src: "lookup",
            onDone: ({ output }) => (output.found ? { target: "found" } : { target: "missing" }),
            onError: { target: "failed" },
          },
        },
        found: { type: "final" },
        missing: { type: "final" },
        failed: { type: "final" },
      },
    });
  }

  test("every listed output is a branch, so both arms of an onDone choice are reached", async () => {
    const report = await explorePaths(createLookupMachine(), {
      outputs: { lookup: [{ found: true }, { found: false }] },
    });
    expect(report.terminals.map((t) => t.state)).toEqual(["found", "missing"]);
    const { witness } = await canReach(createLookupMachine(), "missing", {
      outputs: { lookup: [{ found: true }, { found: false }] },
    });
    expect(witness).toEqual([{ type: "xstate.done.actor.lookup", output: { found: false } }]);
  });

  test("an errors entry for the same src adds the failing branch", async () => {
    const report = await explorePaths(createLookupMachine(), {
      outputs: { lookup: [{ found: true }, { found: false }] },
      errors: { lookup: new Error("down") },
    });
    expect(report.terminals.map((t) => t.state)).toEqual(["failed", "found", "missing"]);
  });

  test("a one-element list is a plain canned output, and outputs replace invokes", async () => {
    const report = await explorePaths(createLookupMachine(), {
      invokes: { lookup: { found: true } },
      outputs: { lookup: [{ found: false }] },
    });
    expect(report.terminals).toEqual([{ status: "done", path: [], state: "missing" }]);
  });

  test("text requests branch over outputs too, resolving as text results", async () => {
    const agent = setupAgent({ context: z.object({}) });
    const machine = agent.createMachine({
      context: {},
      initial: "asking",
      states: {
        asking: {
          invoke: {
            id: "ask",
            src: "agent.generateText",
            input: () => ({ model: "quick", prompt: "yes or no?" }),
            onDone: ({ output }) =>
              (output as { result: unknown }).result === "yes"
                ? { target: "yes" }
                : { target: "no" },
          },
        },
        yes: { type: "final" },
        no: { type: "final" },
      },
    });
    const report = await explorePaths(machine, {
      outputs: { "agent.generateText": ["yes", "no"] },
    });
    expect(report.terminals.map((t) => t.state)).toEqual(["yes", "no"]);
  });
});

describe("explorePaths — dedupeBy", () => {
  function createDiamondMachine() {
    const agent = setupAgent({
      context: z.object({ x: z.number() }),
      events: {
        A: z.object({}),
        B: z.object({}),
        SET: z.object({ x: z.number() }),
        GO: z.object({}),
      },
    });
    return agent.createMachine({
      context: { x: 0 },
      initial: "start",
      states: {
        start: { on: { A: { target: "mid" }, B: { target: "mid" } } },
        mid: {
          on: { SET: ({ event }) => ({ target: "set", context: { x: event.x } }) },
        },
        set: { on: { GO: { target: "end" } } },
        end: { type: "final" },
      },
    });
  }
  const sets = () => ({ SET: [{ x: 1 }, { x: 2 }] });
  const byState = (snapshot: { value: unknown; context: unknown }) =>
    JSON.stringify([snapshot.value, snapshot.context]);

  test("converging branches are explored once per key", async () => {
    const full = await explorePaths(createDiamondMachine(), { payloads: sets });
    const deduped = await explorePaths(createDiamondMachine(), {
      payloads: sets,
      dedupeBy: byState,
    });
    expect(full.pathsExplored).toBe(4);
    expect(deduped.pathsExplored).toBe(2);
  });

  test("a key over state and context keeps payload-distinct contexts apart", async () => {
    const { witness } = await canReach(
      createDiamondMachine(),
      (snapshot) => snapshot.matches("end") && snapshot.context.x === 2,
      { payloads: sets, dedupeBy: byState },
    );
    expect(witness).toEqual([{ type: "A" }, { type: "SET", x: 2 }, { type: "GO" }]);
  });

  test("a key reached again at a shallower depth is explored again", async () => {
    const agent = setupAgent({
      context: z.object({}),
      events: { LONG: z.object({}), SHORT: z.object({}), GO: z.object({}) },
    });
    const machine = agent.createMachine({
      context: {},
      initial: "start",
      states: {
        // DFS takes LONG first and reaches `hub` at depth 3, too deep to
        // finish; SHORT reaches it at depth 1, with room to spare.
        start: { on: { LONG: { target: "l1" }, SHORT: { target: "hub" } } },
        l1: { on: { GO: { target: "l2" } } },
        l2: { on: { GO: { target: "hub" } } },
        hub: { on: { GO: { target: "h1" } } },
        h1: { on: { GO: { target: "goal" } } },
        goal: { type: "final" },
      },
    });
    const report = await explorePaths(machine, {
      maxDepth: 4,
      dedupeBy: (snapshot) => JSON.stringify(snapshot.value),
    });
    const done = report.terminals.filter((t) => t.status === "done");
    expect(done.map((t) => t.path.map((event) => event.type))).toEqual([["SHORT", "GO", "GO"]]);
  });
});

describe("canReach completeness", () => {
  const loop = createMachine({
    initial: "a",
    states: {
      a: { on: { NEXT: { target: "b" } } },
      b: { on: { NEXT: { target: "a" }, FINISH: { target: "goal" } } },
      goal: { type: "final" },
      never: {},
    },
  });

  test("an exhaustive search reports complete", async () => {
    const result = await canReach(loop, "never", { maxDepth: 2 });
    expect(result.reachable).toBe(false);
    expect(result.complete).toBe(false);
    const full = await canReach(
      createMachine({
        initial: "a",
        states: { a: { on: { GO: { target: "b" } } }, b: { type: "final" }, c: {} },
      }),
      "c",
    );
    expect(full).toMatchObject({ reachable: false, complete: true });
  });

  test("a path cap cut short is not a proof", async () => {
    const result = await canReach(loop, "never", { maxPaths: 1, maxDepth: 50 });
    expect(result).toMatchObject({ reachable: false, complete: false });
  });
});

describe("canReach — shortest witness", () => {
  // Depth-first search takes LONG first and would answer with the long route.
  const twoRoutes = createMachine({
    initial: "start",
    states: {
      start: { on: { LONG: { target: "l1" }, SHORT: { target: "goal" } } },
      l1: { on: { NEXT: { target: "l2" } } },
      l2: { on: { NEXT: { target: "goal" } } },
      goal: { type: "final" },
    },
  });

  test("the witness is the short route, while explorePaths keeps depth-first order", async () => {
    const { witness } = await canReach(twoRoutes, "goal");
    expect(witness).toEqual([{ type: "SHORT" }]);
    const report = await explorePaths(twoRoutes);
    expect(report.terminals.map((t) => t.path.map((e) => e.type))).toEqual([
      ["LONG", "NEXT", "NEXT"],
      ["SHORT"],
    ]);
  });

  test("with dedupeBy, the witness is still the short route", async () => {
    const { witness } = await canReach(twoRoutes, "goal", {
      dedupeBy: (snapshot) => JSON.stringify(snapshot.value),
    });
    expect(witness).toEqual([{ type: "SHORT" }]);
  });

  test("over output forks, a retry loop does not lengthen the witness", async () => {
    const agent = setupAgent({
      context: z.object({}),
      events: { RETRY: z.object({}) },
      actors: {
        lookup: createAsyncLogic<{ found: boolean }>({ run: async () => ({ found: true }) }),
      },
    });
    const machine = agent.createMachine({
      context: {},
      initial: "lookingUp",
      states: {
        lookingUp: {
          invoke: {
            id: "lookup",
            src: "lookup",
            onDone: ({ output }) => (output.found ? { target: "found" } : { target: "waiting" }),
          },
        },
        // A miss waits for a retry; depth-first search would retry down to
        // `maxDepth` before trying the hit.
        waiting: { on: { RETRY: { target: "lookingUp" } } },
        found: { type: "final" },
      },
    });
    const { witness } = await canReach(machine, "found", {
      outputs: { lookup: [{ found: false }, { found: true }] },
    });
    expect(witness).toEqual([{ type: "xstate.done.actor.lookup", output: { found: true } }]);
  });

  test("over payloads, the witness takes the one payload that gets there", async () => {
    const counter = setupAgent({
      context: z.object({ total: z.number() }),
      events: { ADD: z.object({ n: z.number() }) },
    }).createMachine({
      context: { total: 0 },
      on: {
        ADD: ({ context, event }) => ({ context: { total: context.total + event.n } }),
      },
    });
    const { witness } = await canReach(counter, (snapshot) => snapshot.context.total >= 2, {
      payloads: () => ({ ADD: [{ n: 1 }, { n: 2 }] }),
      maxDepth: 4,
    });
    expect(witness).toEqual([{ type: "ADD", n: 2 }]);
  });

  test("with dedupeBy, a key reached again with more depth left is explored again", async () => {
    const agent = setupAgent({
      context: z.object({}),
      events: { LONG: z.object({}), SHORT: z.object({}), GO: z.object({}) },
      actors: { check: createAsyncLogic({ run: async () => "ok" }) },
    });
    const machine = agent.createMachine({
      context: {},
      initial: "start",
      states: {
        // SHORT reaches `hub` first by path length (one event) but spends three
        // depth on it: each check's success branch is an unrecorded fork. LONG
        // reaches it second, at depth 2, with enough depth left to finish.
        start: { on: { LONG: { target: "l1" }, SHORT: { target: "c1" } } },
        c1: {
          invoke: {
            id: "c1",
            src: "check",
            onDone: { target: "c2" },
            onError: { target: "failed" },
          },
        },
        c2: {
          invoke: {
            id: "c2",
            src: "check",
            onDone: { target: "hub" },
            onError: { target: "failed" },
          },
        },
        l1: { on: { GO: { target: "hub" } } },
        hub: { on: { GO: { target: "h1" } } },
        h1: { on: { GO: { target: "goal" } } },
        goal: { type: "final" },
        failed: { type: "final" },
      },
    });
    const { witness } = await canReach(machine, "goal", {
      invokes: { check: "ok" },
      errors: { check: new Error("down") },
      maxDepth: 4,
      dedupeBy: (snapshot) => JSON.stringify(snapshot.value),
    });
    expect(witness?.map((event) => event.type)).toEqual(["LONG", "GO", "GO", "GO"]);
  });

  test("a path cap is reported only when it cut a branch", async () => {
    const fork = createMachine({
      initial: "start",
      states: {
        start: { on: { A: { target: "a" }, B: { target: "b" } } },
        a: { type: "final" },
        b: { type: "final" },
        never: {},
      },
    });
    expect(await canReach(fork, "never", { maxPaths: 2 })).toMatchObject({
      reachable: false,
      complete: true,
    });
    expect(await canReach(fork, "never", { maxPaths: 1 })).toMatchObject({
      reachable: false,
      complete: false,
    });
  });
});
