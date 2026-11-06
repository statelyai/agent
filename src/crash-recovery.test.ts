import { describe, expect, test } from "vitest";
import { createAsyncLogic } from "xstate";
import { z } from "zod";
import { checkCrashRecovery } from "./crash-recovery.js";
import { createInMemoryEventLogStore, type AgentEventLogStore } from "./event-log-store.js";
import {
  AGENT_USAGE_EVENT_TYPE,
  createAgentSchemas,
  createDecisionLogic,
  createTextLogic,
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
  test("a re-executed call's usage is counted once", async () => {
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
