import { describe, expect, test } from "vitest";
import { createAsyncLogic, createCallbackLogic } from "xstate";
import { z } from "zod";
import { checkCrashRecovery } from "./crash-recovery.js";
import { createInMemoryEventLogStore, type AgentEventLogStore } from "./event-log-store.js";
import {
  AGENT_USAGE_EVENT_TYPE,
  createAgentSchemas,
  createDecisionLogic,
  createAgentRuntime,
  createTextLogic,
  runToQuiescence,
  setupAgent,
  type AgentDecisionExecutor,
} from "./index.js";

const executors = {
  generateText: async (request: { prompt?: unknown }) => ({
    result: `re: ${String(request.prompt)}`,
  }),
  decide: (async () => ({ event: { type: "APPROVE" } as never })) as AgentDecisionExecutor,
};

// tool → draft → decide → (idle for REVIEW) → publish
function createPipeline() {
  const draft = createTextLogic({ model: "m", prompt: "Draft." });
  const choose = createDecisionLogic({
    model: "m",
    prompt: "Approve?",
    allowedEvents: ["APPROVE"] as const,
  });
  return setupAgent({
    schemas: createAgentSchemas({
      context: z.object({ fetched: z.number(), draft: z.string(), published: z.boolean() }),
      events: { APPROVE: z.object({}), REVIEW: z.object({ ok: z.boolean() }) },
    }),
    actors: {
      draft,
      choose,
      fetch: createAsyncLogic({ run: async () => 42 }),
      publish: createAsyncLogic({ run: async () => true }),
    },
  }).createMachine({
    context: { fetched: 0, draft: "", published: false },
    initial: "fetching",
    states: {
      fetching: {
        invoke: {
          id: "fetch",
          src: "fetch",
          onDone: ({ context, event }) => ({
            target: "drafting",
            context: { ...context, fetched: event.output as number },
          }),
        },
      },
      drafting: {
        invoke: {
          id: "draft",
          src: "draft",
          onDone: ({ context, event }) => ({
            target: "deciding",
            context: { ...context, draft: JSON.stringify(event.output) },
          }),
        },
      },
      deciding: {
        invoke: { id: "choose", src: "choose", input: {} },
        on: { APPROVE: { target: "review" } },
      },
      review: { on: { REVIEW: { target: "publishing" } } },
      publishing: {
        invoke: {
          id: "publish",
          src: "publish",
          onDone: ({ context }) => ({ target: "done", context: { ...context, published: true } }),
        },
      },
      done: { type: "final", output: ({ context }) => context },
    },
  });
}

describe("checkCrashRecovery", () => {
  test("a pipeline recovers from a crash at every log point and in-flight effect", async () => {
    const report = await checkCrashRecovery(createPipeline(), {
      executors,
      events: [{ type: "REVIEW", ok: true }],
    });
    expect(report.failures).toEqual([]);
    expect(report.unreached).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.baseline.status).toBe("done");
    expect(report.baseline.output).toMatchObject({ fetched: 42, published: true });
    expect(report.baseline.effects.map((effect) => effect.key)).toEqual([
      "actor:fetch",
      "draft#1",
      "choose#1.0",
      "actor:publish",
    ]);
    const kinds = report.points.map((point) => point.kind);
    expect(kinds.filter((kind) => kind === "effect")).toHaveLength(4);
    expect(kinds.filter((kind) => kind === "log").length).toBeGreaterThan(2);
  });

  test("a child machine's tool does not re-run once its completion is durable", async () => {
    const worker = setupAgent({
      schemas: createAgentSchemas({ context: z.object({}), events: {} }),
      actors: {
        tool: createAsyncLogic({ run: async () => 1 }),
        summarize: createTextLogic({ model: "m", prompt: "Sum." }),
      },
    }).createMachine({
      context: {},
      initial: "tool",
      states: {
        tool: { invoke: { id: "tool", src: "tool", onDone: { target: "work" } } },
        work: { invoke: { id: "summarize", src: "summarize", onDone: { target: "done" } } },
        done: { type: "final" },
      },
    });
    const parent = setupAgent({
      schemas: createAgentSchemas({ context: z.object({}), events: {} }),
      actors: { worker },
    }).createMachine({
      context: {},
      initial: "running",
      states: {
        running: { invoke: { id: "worker", src: "worker", onDone: { target: "done" } } },
        done: { type: "final" },
      },
    });
    const report = await checkCrashRecovery(parent, { executors });
    expect(report.failures).toEqual([]);
    expect(report.baseline.effects.map((effect) => effect.key)).toEqual([
      "actor:worker/tool",
      "worker/summarize#1",
    ]);
  });

  test("a grandchild's completion reaches its parent after a crash between them", async () => {
    const inner = setupAgent({
      schemas: createAgentSchemas({ context: z.object({}), events: {} }),
      actors: { summarize: createTextLogic({ model: "m", prompt: "Sum." }) },
    }).createMachine({
      context: {},
      initial: "work",
      states: {
        work: { invoke: { id: "summarize", src: "summarize", onDone: { target: "done" } } },
        done: { type: "final", output: () => "inner done" },
      },
    });
    const middle = setupAgent({
      schemas: createAgentSchemas({ context: z.object({}), events: {} }),
      actors: { inner, tool: createAsyncLogic({ run: async () => 1 }) },
    }).createMachine({
      context: {},
      initial: "inner",
      states: {
        inner: { invoke: { id: "inner", src: "inner", onDone: { target: "tool" } } },
        tool: { invoke: { id: "tool", src: "tool", onDone: { target: "done" } } },
        done: { type: "final" },
      },
    });
    const root = setupAgent({
      schemas: createAgentSchemas({ context: z.object({}), events: {} }),
      actors: { middle },
    }).createMachine({
      context: {},
      initial: "running",
      states: {
        running: { invoke: { id: "middle", src: "middle", onDone: { target: "done" } } },
        done: { type: "final" },
      },
    });
    const report = await checkCrashRecovery(root, { executors });
    expect(report.failures).toEqual([]);
    expect(report.baseline.effects.map((effect) => effect.key)).toEqual([
      "middle/inner/summarize#1",
      "actor:middle/tool",
    ]);
  });

  test("reports effects that re-run when the store loses an acknowledged write", async () => {
    // Write-behind: an append is acknowledged before it is stored, so the
    // last one dies with the process.
    const writeBehind = (): AgentEventLogStore => {
      const store = createInMemoryEventLogStore();
      let pending: Parameters<AgentEventLogStore["append"]>[0] | undefined;
      return {
        read: (threadId, options) => store.read(threadId, options),
        length: (threadId) => store.length(threadId),
        fork: (input) => store.fork(input),
        async append(input) {
          if (pending && input.expectedIndex === pending.expectedIndex + pending.entries.length) {
            await store.append(pending);
          }
          pending = input;
        },
      };
    };
    const report = await checkCrashRecovery(createPipeline(), {
      executors,
      events: [{ type: "REVIEW", ok: true }],
      store: writeBehind,
    });
    expect(report.ok).toBe(false);
    expect(report.failures.some((failure) => failure.problem === "reran")).toBe(true);
  });

  test("an executor that answers by call order gets its recorded answer after a crash", async () => {
    let calls = 0;
    const report = await checkCrashRecovery(createPipeline(), {
      executors: { ...executors, generateText: async () => ({ result: `draft ${++calls}` }) },
      events: [{ type: "REVIEW", ok: true }],
    });
    expect(report.failures).toEqual([]);
    expect(calls).toBe(1);
  });
});

describe("usage across a crash", () => {
  test("a finished call's usage and result land in one append, so no crash re-runs it", async () => {
    const machine = setupAgent({
      schemas: createAgentSchemas({ context: z.object({ tokens: z.number() }), events: {} }),
      actors: { ask: createTextLogic({ model: "m", prompt: "q" }) },
    }).createMachine({
      context: { tokens: 0 },
      initial: "asking",
      on: {
        [AGENT_USAGE_EVENT_TYPE]: ({ context, event }) => ({
          context: { tokens: context.tokens + (event.usage.totalTokens ?? 0) },
        }),
      },
      states: {
        asking: { invoke: { id: "ask", src: "ask", onDone: { target: "done" } } },
        done: { type: "final", output: ({ context }) => context },
      },
    });
    const report = await checkCrashRecovery(machine, {
      executors: { generateText: async () => ({ result: "x", usage: { totalTokens: 100 } }) },
    });
    expect(report.failures).toEqual([]);
    expect(report.baseline.output).toEqual({ tokens: 100 });
  });
});

describe("child inputs across a crash", () => {
  test("a parent's send to its child and the child's reply land with the event that caused them", async () => {
    const child = setupAgent({
      schemas: createAgentSchemas({
        context: z.object({ notes: z.number() }),
        events: { NOTE: z.object({}), REPORT: z.object({}) },
      }),
    }).createMachine({
      context: { notes: 0 },
      on: {
        NOTE: ({ context }) => ({ context: { notes: context.notes + 1 } }),
        REPORT: ({ context, parent }, enq) => {
          if (parent) enq.sendTo(parent, { type: "REPORTED", notes: context.notes });
        },
      },
    });
    const parent = setupAgent({
      schemas: createAgentSchemas({
        context: z.object({ notes: z.number() }),
        events: {
          PING: z.object({}),
          DONE: z.object({}),
          REPORTED: z.object({ notes: z.number() }),
        },
      }),
      actors: { child },
    }).createMachine({
      context: { notes: -1 },
      invoke: { id: "child", src: "child" },
      initial: "on",
      states: {
        on: {
          on: {
            PING: ({ children }, enq) => {
              enq.sendTo(children.child, { type: "NOTE" });
            },
            DONE: ({ children }, enq) => {
              enq.sendTo(children.child, { type: "REPORT" });
            },
            REPORTED: ({ event }) => ({ target: "done", context: { notes: event.notes } }),
          },
        },
        done: { type: "final", output: ({ context }) => context },
      },
    });
    const report = await checkCrashRecovery(parent, {
      events: [{ type: "PING" }, { type: "DONE" }],
    });
    expect(report.baseline.output).toEqual({ notes: 1 });
    expect(report.failures).toEqual([]);
  });
});

describe("the final write", () => {
  test("a rejected last batch settles the run as a journal error", async () => {
    const machine = setupAgent({
      schemas: createAgentSchemas({ context: z.object({}), events: { GO: z.object({}) } }),
    }).createMachine({
      context: {},
      initial: "waiting",
      states: { waiting: { on: { GO: { target: "done" } } }, done: { type: "final" } },
    });
    const inner = createInMemoryEventLogStore();
    let appends = 0;
    const store: AgentEventLogStore = {
      read: (threadId, options) => inner.read(threadId, options),
      length: (threadId) => inner.length(threadId),
      fork: (input) => inner.fork(input),
      async append(input) {
        if (appends++ > 0) throw new Error("disk full");
        await inner.append(input);
      },
    };
    const first = await runToQuiescence(createAgentRuntime(machine, { store, threadId: "t" }), {});
    expect(first.status).toBe("idle");
    const second = await runToQuiescence(createAgentRuntime(machine, { store, threadId: "t" }), {
      event: { type: "GO" },
    });
    expect(second.status === "error" && second.cause).toBe("journal");
  });
});

describe("harness coverage", () => {
  test("a child machine under two sources is tracked under both", async () => {
    const worker = setupAgent({
      schemas: createAgentSchemas({ context: z.object({}), events: {} }),
      actors: { tool: createAsyncLogic({ run: async () => 1 }) },
    }).createMachine({
      context: {},
      initial: "tool",
      states: {
        tool: { invoke: { id: "tool", src: "tool", onDone: { target: "done" } } },
        done: { type: "final" },
      },
    });
    const parent = setupAgent({
      schemas: createAgentSchemas({ context: z.object({}), events: {} }),
      actors: { first: worker, second: worker },
    }).createMachine({
      context: {},
      initial: "a",
      states: {
        a: { invoke: { id: "a", src: "first", onDone: { target: "b" } } },
        b: { invoke: { id: "b", src: "second", onDone: { target: "done" } } },
        done: { type: "final" },
      },
    });
    const report = await checkCrashRecovery(parent, {});
    expect(report.failures).toEqual([]);
    expect(report.baseline.effects.map((effect) => effect.key)).toEqual([
      "actor:a/tool",
      "actor:b/tool",
    ]);
  });

  test("a child machine supplied through `actors` replays", async () => {
    const worker = setupAgent({
      schemas: createAgentSchemas({ context: z.object({}), events: {} }),
      actors: { tool: createAsyncLogic({ run: async () => 1 }) },
    }).createMachine({
      context: {},
      initial: "tool",
      states: {
        tool: { invoke: { id: "tool", src: "tool", onDone: { target: "done" } } },
        done: { type: "final" },
      },
    });
    const parent = setupAgent({
      schemas: createAgentSchemas({ context: z.object({}), events: {} }),
      actors: { worker: createAsyncLogic({ run: async () => 0 }) },
    }).createMachine({
      context: {},
      initial: "running",
      states: {
        running: { invoke: { id: "worker", src: "worker", onDone: { target: "done" } } },
        done: { type: "final" },
      },
    });
    const report = await checkCrashRecovery(parent, { actors: { worker } });
    expect(report.failures).toEqual([]);
    expect(report.baseline.effects.map((effect) => effect.key)).toEqual(["actor:worker/tool"]);
  });

  test("a host event is not mistaken for an internal event of the same shape", async () => {
    const parent = setupAgent({
      schemas: createAgentSchemas({
        context: z.object({ pings: z.number() }),
        events: { PING: z.object({}) },
      }),
      actors: {
        pinger: createCallbackLogic(({ sendBack }) => {
          sendBack({ type: "PING" });
        }),
      },
    }).createMachine({
      context: { pings: 0 },
      initial: "first",
      states: {
        first: {
          invoke: { src: "pinger" },
          on: {
            PING: ({ context }) => ({ target: "second", context: { pings: context.pings + 1 } }),
          },
        },
        second: {
          on: {
            PING: ({ context }) => ({ target: "done", context: { pings: context.pings + 1 } }),
          },
        },
        done: { type: "final", output: ({ context }) => context },
      },
    });
    const report = await checkCrashRecovery(parent, { events: [{ type: "PING" }] });
    expect(report.baseline.output).toEqual({ pings: 2 });
    expect(report.failures).toEqual([]);
  });
});

describe("child replies across a model call", () => {
  test("a child's reply lands with its input when the same transition starts a model call", async () => {
    const child = setupAgent({
      schemas: createAgentSchemas({ context: z.object({}), events: { REPORT: z.object({}) } }),
    }).createMachine({
      context: {},
      on: {
        REPORT: ({ parent }, enq) => {
          if (parent) enq.sendTo(parent, { type: "REPORTED" });
        },
      },
    });
    const parent = setupAgent({
      schemas: createAgentSchemas({
        context: z.object({ reported: z.boolean() }),
        events: { GO: z.object({}), REPORTED: z.object({}) },
      }),
      actors: { child, draft: createTextLogic({ model: "m", prompt: "Draft." }) },
    }).createMachine({
      context: { reported: false },
      invoke: { id: "child", src: "child" },
      initial: "waiting",
      on: { REPORTED: ({ context }) => ({ context: { ...context, reported: true } }) },
      states: {
        waiting: {
          on: {
            GO: ({ children }, enq) => {
              enq.sendTo(children.child, { type: "REPORT" });
              return { target: "drafting" };
            },
          },
        },
        drafting: { invoke: { id: "draft", src: "draft", onDone: { target: "done" } } },
        done: { type: "final", output: ({ context }) => context },
      },
    });
    const report = await checkCrashRecovery(parent, { executors, events: [{ type: "GO" }] });
    expect(report.baseline.output).toEqual({ reported: true });
    expect(report.failures).toEqual([]);
  });
});

describe("a store that fails", () => {
  test("a read that rejects is reported per crash point", async () => {
    let stores = 0;
    const report = await checkCrashRecovery(createPipeline(), {
      executors,
      events: [{ type: "REVIEW", ok: true }],
      store: () => {
        const inner = createInMemoryEventLogStore();
        // The baseline's store works; every later one fails to read.
        const broken = stores++ > 0;
        return {
          read: (threadId, options) =>
            broken ? Promise.reject(new Error("offline")) : inner.read(threadId, options),
          length: (threadId) => inner.length(threadId),
          fork: (input) => inner.fork(input),
          append: (input) => inner.append(input),
        };
      },
    });
    expect(report.failures.length).toBe(report.points.length);
    expect(new Set(report.failures.map((failure) => failure.problem))).toEqual(new Set(["threw"]));
  });
});

describe("unreached points", () => {
  test("a point no run dies at is reported and fails the check", async () => {
    // The first run takes the long way; every run after skips the second tool.
    let runs = 0;
    const machine = setupAgent({
      schemas: createAgentSchemas({ context: z.object({}), events: {} }),
      actors: {
        route: createAsyncLogic({ run: async () => (runs++ === 0 ? "long" : "short") }),
        extra: createAsyncLogic({ run: async () => 1 }),
      },
    }).createMachine({
      context: {},
      initial: "routing",
      states: {
        routing: {
          invoke: {
            src: "route",
            onDone: ({ event }) => ({ target: event.output === "long" ? "extra" : "done" }),
          },
        },
        extra: { invoke: { src: "extra", onDone: { target: "done" } } },
        done: { type: "final" },
      },
    });
    const report = await checkCrashRecovery(machine, {});
    expect(
      report.unreached.some(
        ({ point, reason }) =>
          point.kind === "effect" && reason === "the run never started that effect",
      ),
    ).toBe(true);
    expect(report.ok).toBe(false);
  });
});

describe("events sent mid-flight", () => {
  // log → draft; CANCEL while either is out ends the run.
  function createCancellable() {
    return setupAgent({
      schemas: createAgentSchemas({
        context: z.object({}),
        events: { CANCEL: z.object({}) },
      }),
      actors: {
        draft: createTextLogic({ model: "m", prompt: "Draft." }),
        log: createAsyncLogic({ run: async () => 1 }),
      },
    }).createMachine({
      context: {},
      initial: "logging",
      on: { CANCEL: { target: ".cancelled" } },
      states: {
        logging: { invoke: { id: "log", src: "log", onDone: { target: "drafting" } } },
        drafting: { invoke: { id: "draft", src: "draft", onDone: { target: "done" } } },
        cancelled: { type: "final", output: () => "cancelled" },
        done: { type: "final", output: () => "drafted" },
      },
    });
  }

  // Killed while the effect is out, the cancel never reaches the log: the
  // resume redelivers it.
  test.each(["draft#1", "actor:log"])(
    "a cancel sent while %s is out wins at every crash point",
    async (during) => {
      const report = await checkCrashRecovery(createCancellable(), {
        executors,
        sendDuring: [{ during, event: { type: "CANCEL" } }],
      });
      expect(report.baseline.output).toBe("cancelled");
      expect(report.baseline.effects.map(({ key }) => key)).toContain(during);
      expect(report.failures).toEqual([]);
      expect(report.ok).toBe(true);
    },
  );

  test("a call whose state is left while its write-ahead lands never reaches the executor", async () => {
    // The cancel lands with the log's completion, so drafting is entered and
    // left in one step: the draft call waits on the journal, then finds its
    // invoke stopped.
    const report = await checkCrashRecovery(createCancellable(), {
      executors,
      sendDuring: [{ during: "actor:log", event: { type: "CANCEL" } }],
    });
    expect(report.baseline.effects.map(({ key }) => key)).toEqual(["actor:log"]);
  });

  test("occurrence targets a later start of the same key", async () => {
    // The first POST fails, the retry is aborted while it is out.
    const machine = setupAgent({
      schemas: createAgentSchemas({
        context: z.object({ attempt: z.number() }),
        events: { ABORT: z.object({}) },
      }),
      actors: {
        post: createAsyncLogic({
          run: async ({ input }: { input: { attempt: number } }) => {
            // A real POST takes a while: the abort lands while it is out.
            await new Promise((resolve) => setTimeout(resolve, 5));
            if (input.attempt === 0) throw new Error("503");
            return "ok";
          },
        }),
      },
    }).createMachine({
      context: { attempt: 0 },
      initial: "posting",
      on: { ABORT: { target: ".aborted" } },
      states: {
        posting: {
          invoke: {
            id: "post",
            src: "post",
            input: ({ context }) => ({ attempt: context.attempt }),
            onDone: { target: "sent" },
            onError: ({ context }) => ({
              target: "posting",
              reenter: true,
              context: { attempt: context.attempt + 1 },
            }),
          },
        },
        sent: { type: "final", output: () => "sent" },
        aborted: { type: "final", output: ({ context }) => `aborted at ${context.attempt}` },
      },
    });
    const report = await checkCrashRecovery(machine, {
      sendDuring: [{ during: "actor:post", occurrence: 1, event: { type: "ABORT" } }],
    });
    expect(report.baseline.output).toBe("aborted at 1");
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
  });

  test("a send whose effect never starts throws", async () => {
    await expect(
      checkCrashRecovery(createCancellable(), {
        executors,
        sendDuring: [{ during: "draft#2", event: { type: "CANCEL" } }],
      }),
    ).rejects.toThrow(/'draft#2'/);
  });
});

describe("host timers", () => {
  test("the harness fires root timers a host would schedule", async () => {
    const machine = setupAgent({
      schemas: createAgentSchemas({ context: z.object({ waited: z.boolean() }), events: {} }),
      actors: { ask: createTextLogic({ model: "m", prompt: "q" }) },
    }).createMachine({
      context: { waited: false },
      initial: "asking",
      states: {
        asking: { invoke: { src: "ask", onDone: { target: "cooling" } } },
        // An hour: the run would never settle if the timer were armed in process.
        cooling: { after: { 3_600_000: { target: "again" } } },
        again: {
          invoke: {
            src: "ask",
            onDone: () => ({ target: "done", context: { waited: true } }),
          },
        },
        done: { type: "final", output: ({ context }) => context },
      },
    });
    const report = await checkCrashRecovery(machine, { executors, timers: "host" });
    expect(report.baseline.output).toEqual({ waited: true });
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
  });

  test("timers fire in due order across a timer that schedules another", async () => {
    // `a` (100) schedules `c` (150, due at 250); `b` (200) is due first.
    const machine = setupAgent({
      schemas: createAgentSchemas({
        context: z.object({ fired: z.array(z.string()) }),
        events: {},
      }),
    }).createMachine({
      context: { fired: [] },
      type: "parallel",
      output: ({ context }) => context.fired,
      states: {
        a: {
          initial: "wait",
          states: {
            wait: {
              after: {
                100: ({ context }) => ({
                  target: "next",
                  context: { fired: [...context.fired, "a"] },
                }),
              },
            },
            next: {
              after: {
                150: ({ context }) => ({
                  target: "end",
                  context: { fired: [...context.fired, "c"] },
                }),
              },
            },
            end: { type: "final" },
          },
        },
        b: {
          initial: "wait",
          states: {
            wait: {
              after: {
                200: ({ context }) => ({
                  target: "end",
                  context: { fired: [...context.fired, "b"] },
                }),
              },
            },
            end: { type: "final" },
          },
        },
      },
    });
    const report = await checkCrashRecovery(machine, { timers: "host" });
    expect(report.baseline.output).toEqual(["a", "b", "c"]);
    expect(report.failures).toEqual([]);
  });

  // Waiting for an answer, with a reminder at 12h and expiry at 72h.
  function createSla() {
    return setupAgent({
      schemas: createAgentSchemas({
        context: z.object({ reminded: z.boolean() }),
        events: { APPROVE: z.object({}) },
      }),
      actors: { ask: createTextLogic({ model: "m", prompt: "q" }) },
    }).createMachine({
      context: { reminded: false },
      initial: "asking",
      states: {
        asking: { invoke: { src: "ask", onDone: { target: "waiting" } } },
        waiting: {
          after: {
            43_200_000: ({ context }) =>
              context.reminded ? undefined : { context: { reminded: true } },
            259_200_000: { target: "expired" },
          },
          on: { APPROVE: { target: "approved" } },
        },
        approved: { type: "final", output: ({ context }) => ({ ...context, approved: true }) },
        expired: { type: "final", output: ({ context }) => ({ ...context, approved: false }) },
      },
    });
  }

  test("host events go before pending timers; a timer's turn fires the soonest", async () => {
    const answered = await checkCrashRecovery(createSla(), {
      executors,
      timers: "host",
      events: [{ type: "APPROVE" }],
    });
    expect(answered.baseline.output).toEqual({ reminded: false, approved: true });
    expect(answered.ok).toBe(true);

    const reminded = await checkCrashRecovery(createSla(), {
      executors,
      timers: "host",
      events: [{ type: "xstate.timer" }, { type: "APPROVE" }],
    });
    expect(reminded.baseline.output).toEqual({ reminded: true, approved: true });
    expect(reminded.failures).toEqual([]);
    expect(reminded.ok).toBe(true);

    const expired = await checkCrashRecovery(createSla(), { executors, timers: "host" });
    expect(expired.baseline.output).toEqual({ reminded: true, approved: false });
    expect(expired.ok).toBe(true);
  });

  test("a timer armed again after a resume is due from its new arming", async () => {
    // `loop.wait` re-arms the same timer id each round (due 1000, then 2000);
    // `watch` reads the round at 1500. A restored due time that outlived its
    // first schedule would fire the second wait at 1000, before the watch.
    const machine = setupAgent({
      schemas: createAgentSchemas({
        context: z.object({ rounds: z.number(), seen: z.number() }),
        events: {},
      }),
      actors: { ask: createTextLogic({ model: "m", prompt: "q" }) },
    }).createMachine({
      context: { rounds: 0, seen: -1 },
      type: "parallel",
      output: ({ context }) => context,
      states: {
        loop: {
          initial: "work",
          states: {
            work: {
              invoke: {
                src: "ask",
                onDone: ({ context }) => ({
                  target: context.rounds === 2 ? "done" : "wait",
                  context: { ...context, rounds: context.rounds + 1 },
                }),
              },
            },
            wait: { after: { 1000: { target: "work" } } },
            done: { type: "final" },
          },
        },
        watch: {
          initial: "waiting",
          states: {
            waiting: {
              after: {
                1500: ({ context }) => ({
                  target: "seen",
                  context: { ...context, seen: context.rounds },
                }),
              },
            },
            seen: { type: "final" },
          },
        },
      },
    });
    const report = await checkCrashRecovery(machine, { executors, timers: "host" });
    expect(report.baseline.output).toEqual({ rounds: 3, seen: 2 });
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
  });

  test("events left when the uninterrupted run ends throw", async () => {
    await expect(
      checkCrashRecovery(createSla(), {
        executors,
        timers: "host",
        events: [{ type: "APPROVE" }, { type: "APPROVE" }],
      }),
    ).rejects.toThrow(/1 of `events` undelivered/);
  });
});
