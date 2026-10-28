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
} from "./index.js";
import { createInMemoryEventLogStore } from "./event-log-store.js";

// Each PICK is one decision at the `pick` invoke site. With `stay`, the chosen
// event is handled in place, so the invoke also completes (`xstate.done.actor`).
function createPickMachine({ stay = false } = {}) {
  const schemas = createAgentSchemas({
    context: z.object({ picks: z.number() }),
    events: { PICK: z.object({}), CHOSE: z.object({}) },
  });
  const choose = createDecisionLogic({
    model: "test-model",
    prompt: "Choose.",
    allowedEvents: ["CHOSE"] as const,
  });
  return setupAgent({ schemas, actors: { choose } }).createMachine({
    context: { picks: 0 },
    initial: "waiting",
    states: {
      waiting: { on: { PICK: { target: "picking" } } },
      picking: {
        invoke: {
          id: "pick",
          src: "choose",
          input: {},
          ...(stay ? { onDone: { target: "waiting" } } : {}),
        },
        on: {
          CHOSE: stay
            ? ({ context }) => ({ context: { picks: context.picks + 1 } })
            : ({ context }) => ({ target: "waiting", context: { picks: context.picks + 1 } }),
        },
      },
    },
  });
}

const siteKeys = (keys: Array<string | undefined>) => keys.map((key) => key?.split(":")[1]);

const recording =
  (keys: Array<string | undefined>): AgentDecisionExecutor =>
  async (_request, info) => {
    keys.push(info?.callKey);
    return { event: { type: "CHOSE" } as never };
  };

describe("decision callKeys", () => {
  test.each([
    ["exits the state", false],
    ["stays in the state", true],
  ])("each turn's decision gets its own key when the chosen event %s", async (_label, stay) => {
    const machine = createPickMachine({ stay });
    const store = createInMemoryEventLogStore();
    const keys: Array<string | undefined> = [];
    for (let turn = 0; turn < 3; turn++) {
      const result = await runToQuiescence(
        createAgentRuntime(machine, {
          store,
          threadId: "t",
          executors: { decide: recording(keys) },
        }),
        turn === 0 ? { input: undefined, event: { type: "PICK" } } : { event: { type: "PICK" } },
      );
      expect(result.status).toBe("idle");
      expect(result.snapshot.context).toEqual({ picks: turn + 1 });
    }
    expect(siteKeys(keys)).toEqual(["pick#1.0", "pick#2.0", "pick#3.0"]);
  });

  test("a resume log that drops a stored decidedBy is not this thread's log", async () => {
    const machine = createPickMachine();
    const store = createInMemoryEventLogStore();
    await runToQuiescence(
      createAgentRuntime(machine, { store, threadId: "t", executors: { decide: recording([]) } }),
      { input: undefined, event: { type: "PICK" } },
    );
    const stored = await store.read("t");
    expect(stored.some((entry) => entry.decidedBy === "pick#1")).toBe(true);
    const events = stored.map(({ decidedBy: _decidedBy, ...entry }) => entry);

    await expect(
      runToQuiescence(
        createAgentRuntime(machine, { store, threadId: "t", executors: { decide: recording([]) } }),
        { events, event: { type: "PICK" } },
      ),
    ).rejects.toMatchObject({ code: "event-log-conflict" });
  });

  test("a decision in flight at a crash re-runs under its own key, not the completed one's", async () => {
    const machine = createPickMachine();
    const store = createInMemoryEventLogStore();
    const keys: Array<string | undefined> = [];
    await runToQuiescence(
      createAgentRuntime(machine, { store, threadId: "t", executors: { decide: recording(keys) } }),
      { input: undefined, event: { type: "PICK" } },
    );

    const controller = new AbortController();
    const crashed = runToQuiescence(
      createAgentRuntime(machine, {
        store,
        threadId: "t",
        signal: controller.signal,
        executors: {
          decide: async (_request, info) => {
            keys.push(info?.callKey);
            controller.abort();
            return await new Promise<never>(() => {});
          },
        },
      }),
      { event: { type: "PICK" } },
    );
    expect((await crashed).status).toBe("error");

    const resumed = await runToQuiescence(
      createAgentRuntime(machine, { store, threadId: "t", executors: { decide: recording(keys) } }),
    );
    expect(resumed.snapshot.context).toEqual({ picks: 2 });
    expect(siteKeys(keys)).toEqual(["pick#1.0", "pick#2.0", "pick#2.0"]);
  });
});

// Each WORK runs the `worker` child machine: a text call at `draft`, then a
// decision at `pick`. The child's own completions and chosen events stay
// inside the child; only its `xstate.done.actor` reaches the root log.
function createWorkerMachine() {
  const childSchemas = createAgentSchemas({
    context: z.object({}),
    output: z.object({}),
    events: { CHOSE: z.object({}) },
  });
  const draft = createTextLogic({ model: "test-model", prompt: "Draft." });
  const choose = createDecisionLogic({
    model: "test-model",
    prompt: "Choose.",
    allowedEvents: ["CHOSE"] as const,
  });
  const worker = setupAgent({ schemas: childSchemas, actors: { draft, choose } }).createMachine({
    context: {},
    initial: "drafting",
    states: {
      drafting: { invoke: { id: "draft", src: "draft", onDone: { target: "picking" } } },
      picking: {
        invoke: { id: "pick", src: "choose", input: {} },
        on: { CHOSE: { target: "done" } },
      },
      done: { type: "final", output: {} },
    },
  });
  const schemas = createAgentSchemas({
    context: z.object({ rounds: z.number() }),
    events: { WORK: z.object({}), CANCEL: z.object({}) },
  });
  return setupAgent({ schemas, actors: { worker } }).createMachine({
    context: { rounds: 0 },
    initial: "waiting",
    states: {
      waiting: { on: { WORK: { target: "working" } } },
      working: {
        invoke: {
          id: "worker",
          src: "worker",
          input: {},
          onDone: ({ context }) => ({ target: "waiting", context: { rounds: context.rounds + 1 } }),
        },
        on: { CANCEL: { target: "waiting" } },
      },
    },
  });
}

describe("callKeys inside an invoked child machine", () => {
  const executors = (keys: Array<string | undefined>) => ({
    generateText: async (_request: unknown, info?: { callKey?: string }) => {
      keys.push(info?.callKey);
      return { result: "draft" };
    },
    decide: recording(keys),
  });

  test("each turn's child calls get their own keys", async () => {
    const machine = createWorkerMachine();
    const store = createInMemoryEventLogStore();
    const keys: Array<string | undefined> = [];
    for (let turn = 0; turn < 3; turn++) {
      const result = await runToQuiescence(
        createAgentRuntime(machine, { store, threadId: "t", executors: executors(keys) }),
        turn === 0 ? { input: undefined, event: { type: "WORK" } } : { event: { type: "WORK" } },
      );
      expect(result.status).toBe("idle");
      expect(result.snapshot.context).toEqual({ rounds: turn + 1 });
    }
    expect(siteKeys(keys)).toEqual([
      "worker#1/draft#1",
      "worker#1/pick#1.0",
      "worker#2/draft#1",
      "worker#2/pick#1.0",
      "worker#3/draft#1",
      "worker#3/pick#1.0",
    ]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("a child call in flight at a crash re-runs under the same key", async () => {
    const machine = createWorkerMachine();
    const store = createInMemoryEventLogStore();
    const keys: Array<string | undefined> = [];
    await runToQuiescence(
      createAgentRuntime(machine, { store, threadId: "t", executors: executors(keys) }),
      { input: undefined, event: { type: "WORK" } },
    );

    const controller = new AbortController();
    const crashed = runToQuiescence(
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
      { event: { type: "WORK" } },
    );
    expect((await crashed).status).toBe("error");

    const resumed = await runToQuiescence(
      createAgentRuntime(machine, { store, threadId: "t", executors: executors(keys) }),
    );
    expect(resumed.snapshot.context).toEqual({ rounds: 2 });
    // The resumed child restarts from its initial state, so its draft re-runs
    // too, under the key the crashed attempt used.
    expect(siteKeys(keys)).toEqual([
      "worker#1/draft#1",
      "worker#1/pick#1.0",
      "worker#2/draft#1",
      "worker#2/pick#1.0",
      "worker#2/draft#1",
      "worker#2/pick#1.0",
    ]);
  });

  test("a child stopped before it completes does not share keys with the next one", async () => {
    const machine = createWorkerMachine();
    const keys: Array<string | undefined> = [];
    let started!: () => void;
    const draftStarted = new Promise<void>((resolve) => (started = resolve));
    const runtime = createAgentRuntime(machine, {
      store: createInMemoryEventLogStore(),
      threadId: "t",
      executors: {
        ...executors(keys),
        generateText: async (_request, info) => {
          keys.push(info?.callKey);
          if (keys.length > 1) return { result: "draft" };
          started();
          return await new Promise<never>(() => {});
        },
      },
    });
    let [state, effects] = await runtime.start({ input: undefined });
    await runtime.execute(effects);
    for (const event of [{ type: "WORK" }, { type: "CANCEL" }, { type: "WORK" }] as const) {
      [state, effects] = runtime.transition(state, event);
      await runtime.execute(effects);
      if (event.type === "WORK" && keys.length === 0) await draftStarted;
    }
    for (let event; (event = await runtime.nextEvent());) {
      [state, effects] = runtime.transition(state, event);
      await runtime.execute(effects);
    }
    const result = await runtime.finish();
    expect(result.snapshot.context).toEqual({ rounds: 1 });
    expect(siteKeys(keys)).toEqual(["worker#1/draft#1", "worker#2/draft#1", "worker#2/pick#1.0"]);
  });
});
