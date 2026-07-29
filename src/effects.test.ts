import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  createAsyncLogic,
  createMachine,
  initialTransition,
  transition,
  type AnyMachineSnapshot,
  type EventObject,
} from "xstate";
import { createAgentSchemas, createTextLogic, setupAgent } from "./index.js";
import {
  createReplayEntry,
  diffEventLogs,
  getAgentEffects,
  initEntry,
  replay,
  ReplayDivergenceError,
  verifyReplay,
  type AgentEffect,
} from "./effects.js";
import type { AgentLogEntry } from "./event-log-store.js";

/** Reads a requestId off any non-`execute` effect (the kind without one). */
function rid(effect: AgentEffect): string | undefined {
  return "requestId" in effect ? effect.requestId : undefined;
}

// A tiny host loop: at each frontier, start the effects and settle the ONE
// external completion the machine is blocked on, journal it, transition. Fire-
// and-forget `execute` effects run inline and produce no event. `taskOutput`
// and `textOutput` stand in for a real task run / model call.
async function drive(
  machine: any,
  input: unknown,
  handlers: {
    taskOutput?: (id: string) => unknown;
    textOutput?: (request: { prompt?: string }) => unknown;
  } = {},
): Promise<{ snapshot: AnyMachineSnapshot; events: AgentLogEntry[]; execCount: number }> {
  const events: AgentLogEntry[] = [initEntry(machine, input)];
  let [snapshot, actions] = initialTransition(machine, input as never);
  let execCount = 0;

  while ((snapshot as AnyMachineSnapshot).status === "active") {
    const effects = getAgentEffects(machine, snapshot as AnyMachineSnapshot, actions, {
      history: events,
    });
    let next: EventObject | undefined;
    for (const effect of effects) {
      if (effect.kind === "execute") {
        effect.exec();
        execCount++;
      } else if (effect.kind === "task") {
        next ??= effect.toDoneEvent(handlers.taskOutput?.(effect.id));
      } else if (effect.kind === "text") {
        next ??= effect.toDoneEvent(handlers.textOutput?.(effect.request));
      } else if (effect.kind === "delay") {
        next ??= effect.event;
      }
    }
    if (!next) {
      break;
    }
    events.push(createReplayEntry(machine, events, next));
    [snapshot, actions] = transition(machine, snapshot, next as never);
  }

  return { snapshot: snapshot as AnyMachineSnapshot, events, execCount };
}

describe("getAgentEffects — ordering", () => {
  test("preserves document order of a transition's actions (execute, task, execute)", () => {
    const order: string[] = [];
    const taskLogic = createAsyncLogic({ run: async () => "done" });

    const machine = createMachine({
      id: "ordering",
      initial: "s",
      states: {
        s: {
          entry: (_args: any, enq: any) => {
            enq(() => order.push("action1"));
            const child = enq.spawn(taskLogic, { id: "task3", input: {} });
            enq.sendTo(child, { type: "PING" });
          },
          on: { GO: { target: "t" } },
        },
        t: { type: "final" },
      },
    });

    const [snapshot, actions] = initialTransition(machine as any, undefined);
    const effects = getAgentEffects(machine as any, snapshot as AnyMachineSnapshot, actions);

    expect(effects.map((effect) => effect.kind)).toEqual(["execute", "task", "execute"]);

    const [first, task, third] = effects as [AgentEffect, AgentEffect, AgentEffect];
    expect(task.kind === "task" && task.id).toBe("task3");

    // The third effect is the sendTo — and it targets the child the middle
    // effect started (this is the ordering the derived-set design lost).
    const sendTo = (third as { action: any }).action;
    expect(sendTo.type).toBe("@xstate.sendTo");
    expect(sendTo.event).toEqual({ type: "PING" });
    expect(sendTo.target?.id).toBe("task3");

    // Running them in order works: action1 fires, then the sendTo exec runs.
    (first as { exec(): void }).exec();
    (third as { exec(): void }).exec();
    expect(order).toEqual(["action1"]);
  });
});

// A machine mixing every effect kind: a fire-and-forget entry action + a plain
// task, then a text request, then a delay.
function mixedAgent() {
  const agent = setupAgent({
    schemas: createAgentSchemas({
      context: z.object({ summary: z.string(), jobbed: z.string() }),
    }),
    actors: {
      summarize: createTextLogic({
        schemas: {
          input: z.object({ topic: z.string() }),
          output: z.object({ summary: z.string() }),
        },
        model: "quick",
        prompt: ({ input }) => `Summarize ${input.topic}`,
      }),
      job: createAsyncLogic({ run: async () => "job-ran" }),
    },
  });

  return agent.createMachine({
    context: () => ({ summary: "", jobbed: "" }),
    initial: "working",
    states: {
      working: {
        entry: (_args: any, enq: any) => enq(() => {}),
        invoke: {
          id: "job",
          src: "job",
          onDone: ({ output }: any) => ({ target: "summarizing", context: { jobbed: output } }),
        },
      },
      summarizing: {
        invoke: {
          id: "summarize",
          src: "summarize",
          input: () => ({ topic: "the run" }),
          onDone: ({ output }: any) => ({
            target: "waiting",
            context: { summary: output.summary },
          }),
        },
      },
      waiting: {
        after: { 500: { target: "done" } },
      },
      done: {
        type: "final",
        output: ({ context }: any) => ({ summary: context.summary, jobbed: context.jobbed }),
      },
    },
  });
}

describe("getAgentEffects — the six-line host loop", () => {
  test("drives text + task + delay + fire-and-forget to done, exec once", async () => {
    const machine = mixedAgent();
    const result = await drive(machine, undefined, {
      taskOutput: () => "job-output",
      textOutput: () => ({ summary: "a summary" }),
    });

    expect(result.snapshot.status).toBe("done");
    expect((result.snapshot as any).output).toEqual({
      summary: "a summary",
      jobbed: "job-output",
    });
    // The fire-and-forget entry action ran exactly once.
    expect(result.execCount).toBe(1);
    // The delay's after-event was journaled as a normal external entry.
    expect(result.events.some((entry) => entry.event.type === "xstate.timer")).toBe(true);
  });
});

// A fan-out machine: N dynamic spawns, reduced by counting done events.
function fanOutMachine() {
  const branch = createAsyncLogic({ run: async ({ input }: any) => `sum:${input.i}` });
  return createMachine({
    id: "fan",
    initial: "fanningOut",
    context: ({ input }: any) => ({ n: input.n, got: 0, sums: {} as Record<string, unknown> }),
    states: {
      fanningOut: {
        entry: (args: any, enq: any) => {
          for (let i = 0; i < args.context.n; i++) {
            enq.spawn(branch, { id: `branch-${i}`, input: { i } });
          }
        },
        always: { target: "collecting" },
      },
      collecting: {
        on: {
          "xstate.done.actor": (args: any) => {
            const id = args.event.actorId as string;
            if (!id.startsWith("branch-")) {
              return undefined;
            }
            const got = args.context.got + 1;
            const sums = { ...args.context.sums, [id]: args.event.output };
            return got >= args.context.n
              ? { target: "done", context: { got, sums } }
              : { context: { got, sums } };
          },
        },
      },
      done: {
        type: "final",
        output: ({ context }: any) => ({ sums: context.sums }),
      },
    },
  });
}

describe("replay — crash / resume", () => {
  test("re-derives owed spawned tasks with correct requestIds after a crash", async () => {
    const machine = fanOutMachine();

    // Uninterrupted baseline.
    const baseline = await drive(machine, { n: 3 }, { taskOutput: (id) => `sum:${id}` });
    expect(baseline.snapshot.status).toBe("done");

    // Interrupted: keep only the journal up to two branch completions.
    const journal: AgentLogEntry[] = [initEntry(machine as any, { n: 3 })];
    journal.push(
      createReplayEntry(machine as any, journal, {
        type: "xstate.done.actor",
        output: "sum:branch-0",
        actorId: "branch-0",
      } as any),
    );
    journal.push(
      createReplayEntry(machine as any, journal, {
        type: "xstate.done.actor",
        output: "sum:branch-1",
        actorId: "branch-1",
      } as any),
    );

    // Fresh process: replay from the log alone.
    const resumed = replay(machine as any, journal);
    expect(resumed.snapshot.status).toBe("active");
    expect(resumed.effects).toHaveLength(1);
    const owed = resumed.effects[0]!;
    expect(owed.kind).toBe("task");
    expect(owed.kind === "task" && owed.id).toBe("branch-2");
    expect(rid(owed)).toBe("branch-2#1");

    // Completing the owed branch finishes the run — identical to uninterrupted.
    const done = (owed as Extract<AgentEffect, { kind: "task" }>).toDoneEvent("sum:branch-2");
    const events = [...journal, createReplayEntry(machine as any, journal, done)];
    const [finalSnapshot] = transition(machine as any, resumed.snapshot as any, done as never);
    expect((finalSnapshot as AnyMachineSnapshot).status).toBe("done");
    expect((finalSnapshot as any).output).toEqual((baseline.snapshot as any).output);
    expect(events.length).toBeGreaterThan(0);
  });
});

// A machine that re-invokes the SAME site id on every completion (done or
// error), so the occurrence counter climbs.
function reentrantMachine() {
  const job = createAsyncLogic({ run: async () => "x" });
  return createMachine({
    id: "reentrant",
    initial: "work",
    states: {
      work: {
        invoke: {
          id: "job",
          src: "job",
          onDone: { target: "work", reenter: true },
          onError: { target: "work", reenter: true },
        },
      },
    },
  }).provide({ actors: { job } as any });
}

describe("getAgentEffects — occurrence determinism", () => {
  test("re-entry yields #2/#3, an error increments, replay is identical", () => {
    const machine = reentrantMachine();

    const doneJob = { type: "xstate.done.actor", output: "x", actorId: "job" } as EventObject;
    const errorJob = {
      type: "xstate.error.actor",
      error: new Error("boom"),
      actorId: "job",
    } as EventObject;

    // Step 1: first entry.
    let [snapshot, actions] = initialTransition(machine as any, undefined);
    let history: EventObject[] = [];
    let effects = getAgentEffects(machine as any, snapshot as AnyMachineSnapshot, actions, {
      history,
    });
    expect(rid(effects[0]!)).toBe("job#1");

    // Step 2: a done re-enters the site → #2.
    history = [doneJob];
    [snapshot, actions] = transition(machine as any, snapshot, doneJob as never);
    effects = getAgentEffects(machine as any, snapshot as AnyMachineSnapshot, actions, { history });
    expect(rid(effects[0]!)).toBe("job#2");

    // Step 3: an ERROR is a completion too → #3.
    history = [doneJob, errorJob];
    [snapshot, actions] = transition(machine as any, snapshot, errorJob as never);
    effects = getAgentEffects(machine as any, snapshot as AnyMachineSnapshot, actions, { history });
    expect(rid(effects[0]!)).toBe("job#3");

    // Replaying the same log yields the identical requestId.
    const journal = [initEntry(machine as any)];
    journal.push(createReplayEntry(machine as any, journal, doneJob));
    journal.push(
      createReplayEntry(machine as any, journal, {
        ...errorJob,
        error: { name: "Error", message: "boom" },
      } as EventObject),
    );
    const replayed = replay(machine as any, journal);
    expect(rid(replayed.effects[0]!)).toBe("job#3");
  });
});

describe("replay — the journal rule (raise)", () => {
  test("an internally-raised event needs no journal entry", () => {
    const job = createAsyncLogic({ run: async () => "ok" });
    const machine = createMachine({
      id: "raiser",
      initial: "a",
      states: {
        a: {
          // The raise is processed inside `transition` — never journaled.
          entry: (_args: any, enq: any) => enq.raise({ type: "STEP" }),
          on: { STEP: { target: "b" } },
        },
        b: {
          invoke: { id: "job", src: "job", onDone: { target: "done" } },
        },
        done: { type: "final" },
      },
    }).provide({ actors: { job } as any });

    // The journal holds only the EXTERNAL job completion — no STEP entry.
    const doneJob = { type: "xstate.done.actor", output: "ok", actorId: "job" } as EventObject;
    const journal = [initEntry(machine as any)];
    journal.push(createReplayEntry(machine as any, journal, doneJob));
    expect(journal.some((entry) => entry.event.type === "STEP")).toBe(false);

    const resumed = replay(machine as any, journal);
    expect(resumed.snapshot.status).toBe("done");
    expect((resumed.snapshot as any).value).toBe("done");
  });
});

describe("getAgentEffects — timers", () => {
  test("a delay surfaces as an effect; replay of its journaled event skips waiting", () => {
    const machine = createMachine({
      id: "timer",
      initial: "wait",
      states: {
        wait: { after: { 1000: { target: "done" } } },
        done: { type: "final" },
      },
    });

    const [snapshot, actions] = initialTransition(machine as any, undefined);
    const effects = getAgentEffects(machine as any, snapshot as AnyMachineSnapshot, actions);
    expect(effects).toHaveLength(1);
    const delay = effects[0]!;
    expect(delay.kind).toBe("delay");
    if (delay.kind !== "delay") {
      throw new Error("expected a delay effect");
    }
    expect(delay.delayMs).toBe(1000);
    expect(delay.event).toEqual({ type: "xstate.timer", id: "xstate.after.1000.timer.wait" });

    // Journal the timer firing as a normal external entry; replay never waits.
    const journal = [initEntry(machine as any)];
    journal.push(createReplayEntry(machine as any, journal, delay.event));
    const resumed = replay(machine as any, journal);
    expect(resumed.snapshot.status).toBe("done");
  });
});

describe("replay — envelope verification", () => {
  const machine = createMachine({
    id: "verified",
    initial: "a",
    context: { count: 0 },
    states: {
      a: {
        on: {
          INC: { context: ({ context }: any) => ({ count: context.count + 1 }) },
          DONE: { target: "done" },
        },
      },
      done: { type: "final" },
    },
  });

  test("creates self-describing JSON entries and verifies every frontier", () => {
    const entries = [initEntry(machine, undefined, { recordedAt: "2026-01-01T00:00:00.000Z" })];
    entries.push(
      createReplayEntry(
        machine,
        entries,
        { type: "INC" },
        {
          recordedAt: "2026-01-01T00:00:01.000Z",
        },
      ),
    );

    expect(entries[0]).toMatchObject({
      schemaVersion: 1,
      id: "evt_00000000",
      index: 0,
      recordedAt: "2026-01-01T00:00:00.000Z",
      machineId: "verified",
      event: { type: "@agent.init" },
      verification: { stateHash: expect.any(String), effectsHash: expect.any(String) },
    });
    const roundTripped = JSON.parse(JSON.stringify(entries)) as AgentLogEntry[];
    expect(verifyReplay(machine, roundTripped).snapshot.context).toEqual({ count: 1 });
  });

  test("pins strict divergence to the first mismatched entry", () => {
    const entries = [initEntry(machine)];
    entries.push(createReplayEntry(machine, entries, { type: "INC" }));
    entries[1] = {
      ...entries[1]!,
      verification: { ...entries[1]!.verification!, stateHash: "deadbeef" },
    };

    expect(() => verifyReplay(machine, entries)).toThrow(ReplayDivergenceError);
    try {
      verifyReplay(machine, entries);
    } catch (error) {
      expect(error).toMatchObject({ eventId: "evt_00000001", index: 1, kind: "state" });
    }
  });

  test("diffs a shared prefix, branch tails, and logical state", () => {
    const prefix = [initEntry(machine)];
    const parent = [...prefix, createReplayEntry(machine, prefix, { type: "INC" })];
    const fork = [...prefix, createReplayEntry(machine, prefix, { type: "DONE" })];

    const diff = diffEventLogs(machine, parent, fork);
    expect(diff.commonPrefix).toEqual({ length: 1, throughEventId: "evt_00000000" });
    expect(diff.parentOnly.map((entry) => entry.event.type)).toEqual(["INC"]);
    expect(diff.forkOnly.map((entry) => entry.event.type)).toEqual(["DONE"]);
    expect(diff.stateChanges).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "/status" })]),
    );
  });
});
