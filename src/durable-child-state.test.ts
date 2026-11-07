import { describe, expect, test } from "vitest";
import { createAsyncLogic, createStepLogic } from "xstate";
import { z } from "zod";
import {
  createAgentRuntime,
  createAgentSchemas,
  createDecisionLogic,
  createTextLogic,
  runToQuiescence,
  setupAgent,
  type AgentDecisionExecutor,
  type AgentRunInit,
} from "./index.js";
import { createInMemoryEventLogStore } from "./event-log-store.js";
import { createReplayEntry, replay } from "./event-log.js";

// The root invokes `worker` once and forwards each WORK to it as GO. On GO the
// worker drafts (a text call at `draft`), then decides (a decision at `pick`),
// and counts the round. It never completes, so its progress lives only in its
// own snapshot.
function createLongLivedMachine() {
  const draft = createTextLogic({ model: "test-model", prompt: "Draft." });
  const choose = createDecisionLogic({
    model: "test-model",
    prompt: "Choose.",
    allowedEvents: ["CHOSE"] as const,
  });
  const worker = setupAgent({
    schemas: createAgentSchemas({
      context: z.object({ rounds: z.number() }),
      events: { GO: z.object({}), CHOSE: z.object({}) },
    }),
    actors: { draft, choose },
  }).createMachine({
    context: { rounds: 0 },
    initial: "idle",
    states: {
      idle: { on: { GO: { target: "drafting" } } },
      drafting: { invoke: { id: "draft", src: "draft", onDone: { target: "picking" } } },
      picking: {
        invoke: { id: "pick", src: "choose", input: {} },
        on: {
          CHOSE: ({ context }) => ({ target: "idle", context: { rounds: context.rounds + 1 } }),
        },
      },
    },
  });
  return setupAgent({
    schemas: createAgentSchemas({ context: z.object({}), events: { WORK: z.object({}) } }),
    actors: { worker },
  }).createMachine({
    context: {},
    invoke: { id: "worker", src: "worker" },
    on: {
      WORK: ({ children }, enq) => {
        enq.sendTo(children.worker as never, { type: "GO" });
      },
    },
  });
}

const siteKeys = (keys: Array<string | undefined>) => keys.map((key) => key?.split(":")[1]);

const workerRounds = (persisted: unknown) =>
  (persisted as { children: { worker: { snapshot: { context: { rounds: number } } } } }).children
    .worker.snapshot.context.rounds;

const executors = (keys: Array<string | undefined>) => ({
  generateText: async (_request: unknown, info?: { callKey?: string }) => {
    keys.push(info?.callKey);
    return { result: "draft" };
  },
  decide: (async (_request, info) => {
    keys.push(info?.callKey);
    return { event: { type: "CHOSE" } as never };
  }) as AgentDecisionExecutor,
});

describe("a long-lived child machine across resumes", () => {
  test("keeps its state and gives each turn's calls their own keys", async () => {
    const machine = createLongLivedMachine();
    const store = createInMemoryEventLogStore();
    const keys: Array<string | undefined> = [];
    let events;
    for (let turn = 0; turn < 3; turn++) {
      const result = await runToQuiescence(
        createAgentRuntime(machine, { store, threadId: "t", executors: executors(keys) }),
        (turn === 0
          ? { input: undefined, event: { type: "WORK" } }
          : { event: { type: "WORK" } }) as AgentRunInit<typeof machine>,
      );
      expect(result.status).toBe("idle");
      expect(workerRounds(result.persist())).toBe(turn + 1);
      events = result.events;
    }
    expect(siteKeys(keys)).toEqual([
      "worker/draft#1",
      "worker/pick#1.0",
      "worker/draft#2",
      "worker/pick#2.0",
      "worker/draft#3",
      "worker/pick#3.0",
    ]);
    // The log alone reproduces the child's state.
    expect(workerRounds(replay(machine, events!).persistedSnapshot)).toBe(3);
  });

  test("resumes from its persisted snapshot", async () => {
    const machine = createLongLivedMachine();
    const store = createInMemoryEventLogStore();
    const keys: Array<string | undefined> = [];
    let snapshot: unknown;
    for (let turn = 0; turn < 2; turn++) {
      const result = await runToQuiescence(
        createAgentRuntime(machine, { store, threadId: "t", executors: executors(keys) }),
        (turn === 0
          ? { input: undefined, event: { type: "WORK" } }
          : {
              snapshot: JSON.parse(JSON.stringify(snapshot)),
              event: { type: "WORK" },
            }) as AgentRunInit<typeof machine>,
      );
      snapshot = result.persist();
    }
    expect(workerRounds(snapshot)).toBe(2);
    expect(siteKeys(keys)).toEqual([
      "worker/draft#1",
      "worker/pick#1.0",
      "worker/draft#2",
      "worker/pick#2.0",
    ]);
  });

  test("a child call in flight at a crash re-runs under its key, on the child's state", async () => {
    const machine = createLongLivedMachine();
    const store = createInMemoryEventLogStore();
    const keys: Array<string | undefined> = [];
    await runToQuiescence(
      createAgentRuntime(machine, { store, threadId: "t", executors: executors(keys) }),
      { input: undefined, event: { type: "WORK" } } as AgentRunInit<typeof machine>,
    );

    const controller = new AbortController();
    const crashed = await runToQuiescence(
      createAgentRuntime(machine, {
        store,
        threadId: "t",
        signal: controller.signal,
        executors: {
          ...executors(keys),
          decide: async (_request, info) => {
            keys.push(info?.callKey);
            controller.abort();
            return await new Promise<never>(() => {});
          },
        },
      }),
      { event: { type: "WORK" } } as AgentRunInit<typeof machine>,
    );
    expect(crashed.status).toBe("error");

    const resumed = await runToQuiescence(
      createAgentRuntime(machine, { store, threadId: "t", executors: executors(keys) }),
    );
    expect(workerRounds(resumed.persist())).toBe(2);
    // The draft settled before the crash, so only the decision re-runs.
    expect(siteKeys(keys)).toEqual([
      "worker/draft#1",
      "worker/pick#1.0",
      "worker/draft#2",
      "worker/pick#2.0",
      "worker/pick#2.0",
    ]);
  });

  test("a grandchild's calls fold too", async () => {
    const draft = createTextLogic({ model: "test-model", prompt: "Draft." });
    // Invoked per GO; completes once its draft lands.
    const review = setupAgent({
      schemas: createAgentSchemas({ context: z.object({}), output: z.object({}) }),
      actors: { draft },
    }).createMachine({
      context: {},
      initial: "drafting",
      states: {
        drafting: { invoke: { id: "draft", src: "draft", onDone: { target: "done" } } },
        done: { type: "final", output: {} },
      },
    });
    const worker = setupAgent({
      schemas: createAgentSchemas({
        context: z.object({ rounds: z.number() }),
        events: { GO: z.object({}) },
      }),
      actors: { review },
    }).createMachine({
      context: { rounds: 0 },
      initial: "idle",
      states: {
        idle: { on: { GO: { target: "reviewing" } } },
        reviewing: {
          invoke: {
            id: "review",
            src: "review",
            onDone: ({ context }) => ({
              target: "idle",
              context: { rounds: context.rounds + 1 },
            }),
          },
        },
      },
    });
    const machine = setupAgent({
      schemas: createAgentSchemas({ context: z.object({}), events: { WORK: z.object({}) } }),
      actors: { worker },
    }).createMachine({
      context: {},
      invoke: { id: "worker", src: "worker" },
      on: {
        WORK: ({ children }, enq) => {
          enq.sendTo(children.worker as never, { type: "GO" });
        },
      },
    });
    const store = createInMemoryEventLogStore();
    const keys: Array<string | undefined> = [];
    let result;
    for (let turn = 0; turn < 2; turn++) {
      result = await runToQuiescence(
        createAgentRuntime(machine, { store, threadId: "t", executors: executors(keys) }),
        (turn === 0
          ? { input: undefined, event: { type: "WORK" } }
          : { event: { type: "WORK" } }) as AgentRunInit<typeof machine>,
      );
      expect(workerRounds(result.persist())).toBe(turn + 1);
    }
    expect(siteKeys(keys)).toEqual(["worker/review/draft#1", "worker/review/draft#2"]);
    const { agentMeta: _meta, ...live } = JSON.parse(JSON.stringify(result!.persist()));
    expect(JSON.parse(JSON.stringify(replay(machine, result!.events).persistedSnapshot))).toEqual(
      live,
    );
  });

  test("an entry addressed to a child the fold does not have is rejected", async () => {
    const machine = createLongLivedMachine();
    const { events } = await runToQuiescence(
      createAgentRuntime(machine, {
        store: createInMemoryEventLogStore(),
        threadId: "t",
        executors: executors([]),
      }),
      { input: undefined, event: { type: "WORK" } } as AgentRunInit<typeof machine>,
    );
    const stray = createReplayEntry(
      machine,
      events,
      { type: "GO" },
      {
        actorPath: ["missing"],
        verification: false,
      },
    );
    expect(() => replay(machine, [...events, stray])).toThrow(/child machine 'missing'/);
    expect(() =>
      createReplayEntry(machine, events, { type: "GO" }, { actorPath: [], verification: false }),
    ).toThrow(/actorPath/);
  });

  test("a call re-entered after a cancel keeps its own key across a crash", async () => {
    const draft = createTextLogic({ model: "test-model", prompt: "Draft." });
    const worker = setupAgent({
      schemas: createAgentSchemas({
        context: z.object({}),
        events: { GO: z.object({}), CANCEL: z.object({}) },
      }),
      actors: { draft },
    }).createMachine({
      context: {},
      initial: "idle",
      states: {
        idle: { on: { GO: { target: "drafting" } } },
        drafting: {
          invoke: { id: "draft", src: "draft", onDone: { target: "idle" } },
          on: { CANCEL: { target: "idle" } },
        },
      },
    });
    const machine = setupAgent({
      schemas: createAgentSchemas({
        context: z.object({}),
        events: { WORK: z.object({}), STOP: z.object({}) },
      }),
      actors: { worker },
    }).createMachine({
      context: {},
      invoke: { id: "worker", src: "worker" },
      on: {
        WORK: ({ children }, enq) => enq.sendTo(children.worker as never, { type: "GO" }),
        STOP: ({ children }, enq) => enq.sendTo(children.worker as never, { type: "CANCEL" }),
      },
    });
    const store = createInMemoryEventLogStore();
    const keys: Array<string | undefined> = [];
    const controller = new AbortController();
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => (started = resolve));
    const runtime = createAgentRuntime(machine, {
      store,
      threadId: "t",
      signal: controller.signal,
      executors: {
        generateText: async (_request, info) => {
          keys.push(info?.callKey);
          if (keys.length === 1) started();
          else controller.abort();
          return await new Promise<never>(() => {});
        },
      },
    });
    let [state, effects] = await runtime.start({ input: undefined });
    await runtime.execute(effects);
    for (const type of ["WORK", "STOP", "WORK"] as const) {
      [state, effects] = runtime.transition(state, { type });
      await runtime.execute(effects);
      if (keys.length === 0) await firstStarted;
    }
    for (let event; (event = await runtime.nextEvent());) {
      [state, effects] = runtime.transition(state, event);
      await runtime.execute(effects);
    }
    expect((await runtime.finish()).status).toBe("error");

    await runToQuiescence(
      createAgentRuntime(machine, { store, threadId: "t", executors: executors(keys) }),
    );
    expect(siteKeys(keys)).toEqual(["worker/draft#1", "worker/draft#2", "worker/draft#2"]);
  });

  test("a child step that throws does not break replay", async () => {
    const worker = setupAgent({
      schemas: createAgentSchemas({ context: z.object({}), events: { BOOM: z.object({}) } }),
    }).createMachine({
      context: {},
      on: {
        BOOM: () => {
          throw new Error("boom");
        },
      },
    });
    const machine = setupAgent({
      schemas: createAgentSchemas({
        context: z.object({ failed: z.boolean() }),
        events: { WORK: z.object({}) },
      }),
      actors: { worker },
    }).createMachine({
      context: { failed: false },
      initial: "running",
      states: {
        running: {
          invoke: {
            id: "worker",
            src: "worker",
            onError: { target: "failed", context: { failed: true } },
          },
          on: {
            WORK: ({ children }, enq) => enq.sendTo(children.worker as never, { type: "BOOM" }),
          },
        },
        failed: {},
      },
    });
    const result = await runToQuiescence(
      createAgentRuntime(machine, {
        store: createInMemoryEventLogStore(),
        threadId: "t",
        executors: executors([]),
      }),
      { input: undefined, event: { type: "WORK" } } as AgentRunInit<typeof machine>,
    );
    expect(result.snapshot.context).toEqual({ failed: true });
    expect(result.events.some((entry) => entry.actorPath !== undefined)).toBe(true);
    expect(replay(machine, result.events).snapshot.context).toEqual({ failed: true });
  });

  test("an invoke id holding a slash does not read as a child path", async () => {
    const draft = createTextLogic({ model: "test-model", prompt: "Draft." });
    const worker = setupAgent({
      schemas: createAgentSchemas({ context: z.object({}), events: { GO: z.object({}) } }),
      actors: { draft },
    }).createMachine({
      context: {},
      initial: "idle",
      states: {
        idle: { on: { GO: { target: "drafting" } } },
        drafting: { invoke: { id: "draft", src: "draft", onDone: { target: "idle" } } },
      },
    });
    const machine = setupAgent({
      schemas: createAgentSchemas({ context: z.object({}), events: { WORK: z.object({}) } }),
      actors: { worker, draft },
    }).createMachine({
      context: {},
      type: "parallel",
      states: {
        child: {
          invoke: { id: "worker", src: "worker" },
          on: {
            WORK: ({ children }, enq) => enq.sendTo(children.worker as never, { type: "GO" }),
          },
        },
        root: {
          initial: "idle",
          states: {
            idle: { on: { WORK: { target: "drafting" } } },
            drafting: { invoke: { id: "worker/draft", src: "draft", onDone: { target: "idle" } } },
          },
        },
      },
    });
    const keys: Array<string | undefined> = [];
    await runToQuiescence(
      createAgentRuntime(machine, {
        store: createInMemoryEventLogStore(),
        threadId: "t",
        executors: executors(keys),
      }),
      { input: undefined, event: { type: "WORK" } } as AgentRunInit<typeof machine>,
    );
    expect(new Set(siteKeys(keys))).toEqual(new Set(["worker%2Fdraft#1", "worker/draft#1"]));
  });

  test("a fired child timer is journaled, so the log reproduces where it moved the child", async () => {
    const worker = setupAgent({
      schemas: createAgentSchemas({ context: z.object({}) }),
    }).createMachine({
      context: {},
      initial: "waiting",
      states: { waiting: { after: { 20: { target: "armed" } } }, armed: {} },
    });
    const machine = setupAgent({
      schemas: createAgentSchemas({ context: z.object({}), events: { PING: z.object({}) } }),
      actors: { worker },
    }).createMachine({
      context: {},
      invoke: { id: "worker", src: "worker" },
      on: { PING: {} },
    });
    const store = createInMemoryEventLogStore();
    const workerValue = (persisted: unknown) =>
      (persisted as { children: { worker: { snapshot: { value: string } } } }).children.worker
        .snapshot.value;

    const first = await runToQuiescence(createAgentRuntime(machine, { store, threadId: "t" }), {
      input: undefined,
    } as AgentRunInit<typeof machine>);
    expect(workerValue(first.persist())).toBe("armed");
    expect(
      first.events?.some(
        (entry) => entry.event.type === "xstate.timer" && entry.actorPath?.[0] === "worker",
      ),
    ).toBe(true);
    expect(workerValue(replay(machine, first.events!).persistedSnapshot)).toBe("armed");

    // Resumed from the log alone, the child stays where its timer moved it.
    const second = await runToQuiescence(createAgentRuntime(machine, { store, threadId: "t" }), {
      event: { type: "PING" },
    } as AgentRunInit<typeof machine>);
    expect(workerValue(second.persist())).toBe("armed");
    const timers = (events: typeof first.events) =>
      events?.filter((entry) => entry.event.type === "xstate.timer").length;
    expect(timers(second.events)).toBe(timers(first.events));
  });
});

describe("a plain actor inside a child machine", () => {
  test("starts only after the child's earlier completion is durable", async () => {
    const seenAtB: string[][] = [];
    const store = createInMemoryEventLogStore();
    const slowStore = {
      ...store,
      append: async (args: Parameters<typeof store.append>[0]) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return store.append(args);
      },
    };
    const toolA = createAsyncLogic({ run: async () => "a" });
    const toolB = createAsyncLogic({
      run: async () => {
        seenAtB.push(
          (await store.read("t")).map(
            (entry) => `${entry.event.type}@${entry.actorPath?.join("/") ?? ""}`,
          ),
        );
        return "b";
      },
    });
    const child = setupAgent({
      context: z.object({}),
      events: {},
      actors: { toolA, toolB },
    }).createMachine({
      context: {},
      initial: "a",
      states: {
        a: { invoke: { src: "toolA", onDone: { target: "b" } } },
        b: { invoke: { src: "toolB", onDone: { target: "done" } } },
        done: { type: "final" },
      },
    });
    const root = setupAgent({
      context: z.object({}),
      events: {},
      actors: { child },
    }).createMachine({
      context: {},
      initial: "run",
      states: {
        run: { invoke: { id: "child", src: "child", onDone: { target: "done" } } },
        done: { type: "final" },
      },
    });
    const runtime = createAgentRuntime(root, { store: slowStore, threadId: "t" });
    const result = await runToQuiescence(runtime, {});
    expect(result.status).toBe("done");
    expect(seenAtB).toHaveLength(1);
    expect(seenAtB[0]).toContain("xstate.done.actor@child");
  });
});

describe("a child that finished just before a crash", () => {
  // root → middle → inner; the crash cuts the log after a child's last entry,
  // before its parent journaled the child's completion.
  function createNested() {
    const inner = setupAgent({
      schemas: createAgentSchemas({ context: z.object({}), events: {} }),
      actors: { summarize: createTextLogic({ model: "test-model", prompt: "Sum." }) },
    }).createMachine({
      context: {},
      initial: "work",
      states: {
        work: { invoke: { id: "summarize", src: "summarize", onDone: { target: "done" } } },
        done: { type: "final", output: () => "inner done" },
      },
    });
    const middle = setupAgent({
      schemas: createAgentSchemas({ context: z.object({ got: z.unknown() }), events: {} }),
      actors: { inner },
    }).createMachine({
      context: { got: undefined },
      initial: "inner",
      states: {
        inner: {
          invoke: {
            id: "inner",
            src: "inner",
            onDone: ({ event }) => ({ target: "done", context: { got: event.output } }),
          },
        },
        done: { type: "final", output: ({ context }) => context },
      },
    });
    return setupAgent({
      schemas: createAgentSchemas({ context: z.object({ got: z.unknown() }), events: {} }),
      actors: { middle },
    }).createMachine({
      context: { got: undefined },
      initial: "running",
      states: {
        running: {
          invoke: {
            id: "middle",
            src: "middle",
            onDone: ({ event }) => ({ target: "done", context: { got: event.output } }),
          },
        },
        done: { type: "final", output: ({ context }) => context },
      },
    });
  }

  test.each([
    ["the root", "middle"],
    ["a child machine", "inner"],
  ])("%s still gets its child's completion on resume", async (_, childId) => {
    const machine = createNested();
    const generateText = async () => ({ result: "sum" });
    const full = await runToQuiescence(
      createAgentRuntime(machine, { executors: { generateText } }),
      {},
    );
    expect(full.status).toBe("done");
    const cut = full.events.findIndex(
      (entry) =>
        entry.event.type === "xstate.done.actor" &&
        (entry.event as { actorId?: string }).actorId === childId,
    );
    expect(cut).toBeGreaterThan(0);
    const calls: unknown[] = [];
    const resumed = await runToQuiescence(
      createAgentRuntime(machine, {
        executors: { generateText: async () => (calls.push(1), { result: "sum" }) },
      }),
      { events: full.events.slice(0, cut) },
    );
    expect(resumed.status).toBe("done");
    expect(resumed.status === "done" && resumed.output).toEqual(
      full.status === "done" && full.output,
    );
    expect(calls).toEqual([]);
  });
});

describe("a plain actor that finishes in the step it starts an effect", () => {
  function createFinishing(ran: string[]) {
    const step = createStepLogic({
      context: {},
      run: ({ event }, enq) => {
        if (event.type !== "GO") return;
        enq.effect(() => void ran.push("effect"));
        return { status: "done", output: "ok" };
      },
    });
    const child = setupAgent({
      schemas: createAgentSchemas({ context: z.object({}), events: { PING: z.object({}) } }),
      actors: { step },
    }).createMachine({
      context: {},
      initial: "waiting",
      states: {
        waiting: {
          invoke: { id: "step", src: "step", onDone: { target: "done" } },
          on: {
            PING: ({ children }, enq) => {
              enq.sendTo(children.step as never, { type: "GO" });
            },
          },
        },
        done: { type: "final" },
      },
    });
    const root = setupAgent({
      schemas: createAgentSchemas({ context: z.object({}), events: { WORK: z.object({}) } }),
      actors: { child },
    }).createMachine({
      context: {},
      initial: "run",
      states: {
        run: {
          invoke: { id: "child", src: "child", onDone: { target: "done" } },
          on: {
            WORK: ({ children }, enq) => {
              enq.sendTo(children.child as never, { type: "PING" });
            },
          },
        },
        done: { type: "final" },
      },
    });
    return root;
  }

  test("still runs that effect when the journal holds it back", async () => {
    const ran: string[] = [];
    const root = createFinishing(ran);
    const store = createInMemoryEventLogStore();
    const result = await runToQuiescence(createAgentRuntime(root, { store, threadId: "t" }), {
      input: undefined,
      event: { type: "WORK" },
    } as AgentRunInit<typeof root>);
    expect(result.status).toBe("done");
    expect(ran).toEqual(["effect"]);
  });

  test("drops that effect when the write of its cause fails", async () => {
    const ran: string[] = [];
    const root = createFinishing(ran);
    const store = createInMemoryEventLogStore();
    const failing = {
      ...store,
      append: async (args: Parameters<typeof store.append>[0]) => {
        if (args.entries.some((entry) => entry.event.type === "PING")) throw new Error("disk full");
        return store.append(args);
      },
    };
    const result = await runToQuiescence(
      createAgentRuntime(root, { store: failing, threadId: "t" }),
      { input: undefined, event: { type: "WORK" } } as AgentRunInit<typeof root>,
    );
    expect(result.status).not.toBe("done");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ran).toEqual([]);
  });

  test("drops that effect when the run is aborted while its cause is written", async () => {
    const ran: string[] = [];
    const root = createFinishing(ran);
    const store = createInMemoryEventLogStore();
    const controller = new AbortController();
    const slow = {
      ...store,
      append: async (args: Parameters<typeof store.append>[0]) => {
        if (args.entries.some((entry) => entry.event.type === "PING")) {
          controller.abort(new Error("host stop"));
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return store.append(args);
      },
    };
    const result = await runToQuiescence(
      createAgentRuntime(root, { store: slow, threadId: "t", signal: controller.signal }),
      { input: undefined, event: { type: "WORK" } } as AgentRunInit<typeof root>,
    );
    expect(result.status).not.toBe("done");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ran).toEqual([]);
  });
});

describe("a restored child completion inside an active parent", () => {
  test("reaches its parent once", async () => {
    const inner = setupAgent({
      schemas: createAgentSchemas({ context: z.object({}), events: {} }),
      actors: { summarize: createTextLogic({ model: "test-model", prompt: "Sum." }) },
    }).createMachine({
      context: {},
      initial: "work",
      states: {
        work: { invoke: { id: "summarize", src: "summarize", onDone: { target: "done" } } },
        done: { type: "final" },
      },
    });
    // `middle` stays put on its child's completion, so a second delivery would count twice.
    const middle = setupAgent({
      schemas: createAgentSchemas({ context: z.object({ done: z.number() }), events: {} }),
      actors: { inner },
    }).createMachine({
      context: { done: 0 },
      invoke: {
        id: "inner",
        src: "inner",
        onDone: ({ context }) => ({ context: { done: context.done + 1 } }),
      },
    });
    const root = setupAgent({
      schemas: createAgentSchemas({ context: z.object({}), events: {} }),
      actors: { middle },
    }).createMachine({ context: {}, invoke: { id: "middle", src: "middle" } });
    const generateText = async () => ({ result: "sum" });
    const full = await runToQuiescence(
      createAgentRuntime(root, { executors: { generateText } }),
      {},
    );
    const cut = full.events.findIndex(
      (entry) =>
        entry.event.type === "xstate.done.actor" &&
        (entry.event as { actorId?: string }).actorId === "inner",
    );
    expect(cut).toBeGreaterThan(0);
    const resumed = await runToQuiescence(
      createAgentRuntime(root, { executors: { generateText } }),
      {
        events: full.events.slice(0, cut),
      },
    );
    const middleDone = (persisted: unknown) =>
      (persisted as { children: { middle: { snapshot: { context: { done: number } } } } }).children
        .middle.snapshot.context.done;
    expect(middleDone(full.persist())).toBe(1);
    expect(middleDone(resumed.persist())).toBe(1);
  });
});
