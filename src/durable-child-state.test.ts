import { describe, expect, test } from "vitest";
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
});
