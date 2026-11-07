import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createAsyncLogic } from "xstate";
import { AGENT_USAGE_EVENT_TYPE, runAgent, setupAgent } from "./index.js";
import { canReach, explorePaths, textOutput } from "./testing/index.js";

// A wait that times out unless GO arrives first.
function createTimeoutMachine() {
  const agent = setupAgent({ context: z.object({}), events: { GO: z.object({}) } });
  return agent.createMachine({
    id: "m",
    context: {},
    initial: "waiting",
    states: {
      waiting: { after: { 1000: { target: "timedOut" } }, on: { GO: { target: "done" } } },
      timedOut: { type: "final" },
      done: { type: "final" },
    },
  });
}

describe("explorePaths — timers", () => {
  test("an armed `after` timer fires as an event that may arrive", async () => {
    const report = await explorePaths(createTimeoutMachine());
    expect(report.complete).toBe(true);
    expect(report.terminals).toEqual([
      { status: "done", path: [{ type: "GO" }], state: "done" },
      {
        status: "done",
        path: [{ type: "xstate.after", delay: 1000, stateId: "m.waiting" }],
        state: "timedOut",
      },
    ]);
    const result = await canReach(createTimeoutMachine(), "timedOut");
    expect(result).toMatchObject({
      reachable: true,
      witness: [{ type: "xstate.after", delay: 1000, stateId: "m.waiting" }],
    });
  });

  test("a fired timer is disarmed: a delayed raise the state ignores fires once", async () => {
    const agent = setupAgent({
      context: z.object({ pings: z.number() }),
      events: { PING: z.object({}) },
    });
    const machine = agent.createMachine({
      context: { pings: 0 },
      initial: "idle",
      states: {
        idle: {
          entry: (_, enq) => {
            enq.raise({ type: "PING" }, { delay: 50 });
          },
          on: { PING: ({ context }) => ({ context: { pings: context.pings + 1 } }) },
        },
      },
    });
    // Only the timer sends PING: the host sends nothing.
    const report = await explorePaths(machine, { hostEvents: [] });
    expect(report.complete).toBe(true);
    expect(report.terminals).toEqual([{ status: "idle", path: [{ type: "PING" }], state: "idle" }]);
  });

  test("timers fire while work is pending under interleave: 'pending'", async () => {
    const agent = setupAgent({
      context: z.object({}),
      actors: { lookup: createAsyncLogic({ run: async () => 1 }) },
    });
    const machine = agent.createMachine({
      id: "m",
      context: {},
      initial: "working",
      states: {
        working: {
          invoke: { id: "lookup", src: "lookup", onDone: { target: "found" } },
          after: { 5000: { target: "timedOut" } },
        },
        found: { type: "final" },
        timedOut: { type: "final" },
      },
    });
    const outputs = { lookup: [1] };
    expect(await canReach(machine, "timedOut", { outputs })).toMatchObject({
      reachable: false,
      complete: true,
    });
    expect(await canReach(machine, "timedOut", { outputs, interleave: "pending" })).toMatchObject({
      reachable: true,
    });
  });

  test("an explored child's timers fire in its own search", async () => {
    const child = setupAgent({ context: z.object({}), events: {} }).createMachine({
      id: "child",
      context: {},
      initial: "waiting",
      states: {
        waiting: { after: { 100: { target: "late" } } },
        late: { type: "final", output: () => "late" },
      },
    });
    const machine = setupAgent({
      context: z.object({}),
      events: {},
      actors: { child },
    }).createMachine({
      context: {},
      initial: "running",
      states: {
        running: {
          invoke: {
            id: "c",
            src: "child",
            onDone: ({ output }) => (output === "late" ? { target: "late" } : { target: "other" }),
          },
        },
        late: { type: "final" },
        other: { type: "final" },
      },
    });
    for (const children of ["explore", "coupled"] as const) {
      expect(await canReach(machine, "late", { children })).toMatchObject({ reachable: true });
    }
  });

  test("timers: 'ignore' leaves the timer unfired and the report incomplete", async () => {
    const report = await explorePaths(createTimeoutMachine(), { timers: "ignore" });
    expect(report.complete).toBe(false);
    expect(report.unexpandedEvents).toEqual(["xstate.after"]);
    expect(report.unexplored).toEqual([
      expect.stringMatching(/^timers: .*xstate\.after.* never fires it$/),
    ]);
    expect(await canReach(createTimeoutMachine(), "timedOut", { timers: "ignore" })).toMatchObject({
      reachable: false,
      complete: false,
    });
  });
});

describe("explorePaths — usage", () => {
  const agent = setupAgent({
    context: z.object({ tokens: z.number() }),
    events: {},
    requests: {
      summarize: { model: "m", schemas: { input: z.object({}), output: z.string() }, prompt: "x" },
    },
  });
  // A budget guard: usage over 100 tokens stops before the summary lands.
  const createBudgetMachine = (onUsage?: (event: unknown) => void) =>
    agent.createMachine({
      context: { tokens: 0 },
      initial: "working",
      states: {
        working: {
          on: {
            [AGENT_USAGE_EVENT_TYPE]: ({ context, event }) => {
              onUsage?.(event);
              const tokens = context.tokens + (event.usage.totalTokens ?? 0);
              return tokens > 100
                ? { target: "overBudget", context: { tokens } }
                : { context: { tokens } };
            },
          },
          invoke: { id: "s", src: "summarize", input: {}, onDone: { target: "done" } },
        },
        overBudget: { type: "final" },
        done: { type: "final" },
      },
    });
  const machine = createBudgetMachine();

  test("forks one branch per usage value, delivered before the completion", async () => {
    const report = await explorePaths(machine, {
      outputs: { summarize: ["ok"] },
      usage: { summarize: [{ totalTokens: 10 }, { totalTokens: 500 }] },
    });
    expect(report.complete).toBe(true);
    expect(report.vacuous).toEqual([]);
    const usageEvent = (totalTokens: number) => ({
      type: AGENT_USAGE_EVENT_TYPE,
      kind: "text",
      id: "s",
      src: "summarize",
      model: "m",
      name: "summarize",
      usage: { totalTokens },
    });
    expect(report.terminals).toEqual([
      {
        status: "done",
        path: [usageEvent(10), { type: "xstate.done.actor", actorId: "s", output: "ok" }],
        state: "done",
      },
      { status: "done", path: [usageEvent(500)], state: "overBudget" },
    ]);
  });

  test("a single output's usage event is on the witness, straight through or raced", async () => {
    const over = {
      type: AGENT_USAGE_EVENT_TYPE,
      kind: "text",
      id: "s",
      src: "summarize",
      model: "m",
      name: "summarize",
      usage: { totalTokens: 500 },
    };
    const options = {
      outputs: { summarize: ["ok"] },
      usage: { summarize: [{ totalTokens: 500 }] },
    };
    expect(await canReach(machine, "overBudget", options)).toMatchObject({
      reachable: true,
      witness: [over],
    });
    expect(
      await canReach(machine, "overBudget", { ...options, interleave: "pending" }),
    ).toMatchObject({ reachable: true, witness: [over] });
    const under = { ...options, usage: { summarize: [{ totalTokens: 10 }] } };
    expect((await explorePaths(machine, under)).terminals).toEqual([
      { status: "done", path: [{ ...over, usage: { totalTokens: 10 } }], state: "done" },
    ]);
  });

  test("the event matches the one a run delivers, bar its budget and call key", async () => {
    const seen: unknown[] = [];
    const run = await runAgent(
      createBudgetMachine((event) => seen.push(event)),
      { executors: { generateText: async () => ({ result: "ok", usage: { totalTokens: 10 } }) } },
    );
    expect(run.status).toBe("done");
    const report = await explorePaths(machine, {
      outputs: { summarize: ["ok", "ok2"] },
      usage: { summarize: [{ totalTokens: 10 }] },
    });
    const { budget: _budget, callKey: _callKey, ...live } = seen[0] as Record<string, unknown>;
    expect(report.terminals[0]!.path[0]).toEqual(live);
  });

  test("without a usage entry, the usage transition is vacuous and the proof says so", async () => {
    const report = await explorePaths(machine, { outputs: { summarize: ["ok"] } });
    expect(report.vacuous).toEqual([AGENT_USAGE_EVENT_TYPE]);
    expect(report.complete).toBe(true);
    expect(await canReach(machine, "overBudget", { outputs: { summarize: ["ok"] } })).toMatchObject(
      { reachable: false },
    );
    expect(
      await canReach(machine, "overBudget", {
        outputs: { summarize: ["ok"] },
        usage: { summarize: [{ totalTokens: 500 }] },
      }),
    ).toMatchObject({ reachable: true });
  });
});

describe("explorePaths — request classification and text envelopes", () => {
  const plain = createAsyncLogic({ run: async () => "real" });
  const ctx = z.object({ got: z.unknown() });
  const requests = {
    reply: { model: "m", schemas: { input: z.object({}), output: z.string() }, prompt: "x" },
  };
  const config = {
    context: { got: null as unknown },
    initial: "go",
    states: {
      go: {
        invoke: {
          id: "r",
          src: "reply",
          input: {},
          onDone: ({ output }: { output: unknown }) => ({
            target: "done",
            context: { got: output },
          }),
        },
      },
      done: {
        type: "final" as const,
        output: ({ context }: { context: { got: unknown } }) => context,
      },
    },
  };

  test("a request src provided a plain actor resolves as a plain invoke, as runAgent runs it", async () => {
    const machine = setupAgent({ context: ctx, events: {}, requests })
      .createMachine(config as never)
      .provide({ actors: { reply: plain } } as never);
    const run = await runAgent(machine, { executors: {} });
    expect(run).toMatchObject({ status: "done", output: { got: "real" } });
    const report = await explorePaths(machine, { outputs: { reply: ["CANNED"] } });
    expect(report.terminals.map((terminal) => terminal.output)).toEqual([{ got: "CANNED" }]);
  });

  test("a registered text request still wraps its canned result", async () => {
    const machine = setupAgent({ context: ctx, events: {}, requests }).createMachine(
      config as never,
    );
    const report = await explorePaths(machine, { outputs: { reply: ["CANNED"] } });
    expect(report.terminals.map((terminal) => terminal.output)).toEqual([
      { got: { result: "CANNED", messages: [] } },
    ]);
  });

  test("textOutput carries messages; the path records the result", async () => {
    const machine = setupAgent({ context: ctx, events: {}, requests }).createMachine(
      config as never,
    );
    const messages = [{ role: "assistant" as const, content: "hi" }];
    const report = await explorePaths(machine, {
      outputs: { reply: [textOutput("hi", { messages }), "bye"] },
    });
    expect(report.terminals).toEqual([
      {
        status: "done",
        path: [{ type: "xstate.done.actor", actorId: "r", output: "hi" }],
        state: "done",
        output: { got: { result: "hi", messages } },
      },
      {
        status: "done",
        path: [{ type: "xstate.done.actor", actorId: "r", output: "bye" }],
        state: "done",
        output: { got: { result: "bye", messages: [] } },
      },
    ]);
  });
});

describe("explorePaths — usage delivery", () => {
  const agent = setupAgent({
    context: z.object({ retried: z.boolean() }),
    events: {},
    requests: {
      summarize: { model: "m", schemas: { input: z.object({}), output: z.string() }, prompt: "x" },
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

  test("a usage value the machine refuses is neither delivered nor recorded", async () => {
    const machine = agent.createMachine({
      context: { retried: false },
      initial: "working",
      states: {
        working: {
          on: {
            [AGENT_USAGE_EVENT_TYPE]: ({ event }) =>
              (event.usage.totalTokens ?? 0) > 100 ? { target: "overBudget" } : undefined,
          },
          invoke: { id: "s", src: "summarize", input: {}, onDone: { target: "done" } },
        },
        overBudget: { type: "final" },
        done: { type: "final" },
      },
    });
    const forked = await explorePaths(machine, {
      outputs: { summarize: ["ok"] },
      usage: { summarize: [{ totalTokens: 500 }, { totalTokens: 10 }] },
    });
    expect(forked.terminals).toEqual([
      { status: "done", path: [usageEvent(500)], state: "overBudget" },
      {
        status: "done",
        path: [{ type: "xstate.done.actor", actorId: "s", output: "ok" }],
        state: "done",
      },
    ]);
    for (const interleave of ["idle", "pending"] as const) {
      const straight = await explorePaths(machine, {
        outputs: { summarize: ["ok"] },
        usage: { summarize: [{ totalTokens: 10 }] },
        interleave,
      });
      expect(straight.terminals).toEqual([{ status: "done", path: [], state: "done" }]);
    }
  });

  test("a usage transition that restarts the invoke drops the old completion", async () => {
    const machine = agent.createMachine({
      context: { retried: false },
      initial: "working",
      states: {
        working: {
          on: {
            [AGENT_USAGE_EVENT_TYPE]: ({ context }) =>
              context.retried
                ? { context: { retried: true } }
                : { target: "working", reenter: true, context: { retried: true } },
          },
          invoke: { id: "s", src: "summarize", input: {}, onDone: { target: "done" } },
        },
        done: { type: "final", output: ({ context }) => context },
      },
    });
    const report = await explorePaths(machine, {
      outputs: { summarize: ["ok"] },
      usage: { summarize: [{ totalTokens: 10 }] },
    });
    // The first completion belonged to the restarted invoke; the new one settles on its own.
    expect(report.terminals).toEqual([
      {
        status: "done",
        path: [usageEvent(10), usageEvent(10)],
        state: "done",
        output: { retried: true },
      },
    ]);
  });
});
