import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createActor } from "xstate";
import {
  createAgentSchemas,
  createTextLogic,
  getAgentRequests,
  initialAgentStep,
  resolveAgentRequests,
  runAgent,
  setupAgent,
} from "./index.js";
import type {
  AgentDecisionExecutor,
  AgentPlanRequest,
  AgentRequestExecutors,
  ChosenEvent,
} from "./index.js";

// A todo-list machine managed by one `agent.plan` invoke. Its final output
// records the plan's stop reason and step count (when onDone fires), so the
// SAME machine driven via runAgent and via the step loop can be compared for
// exact parity.
function createTodoAgent() {
  const agent = setupAgent({
    schemas: createAgentSchemas({
      context: z.object({
        todos: z.array(z.string()),
        stopped: z.string().nullable(),
        steps: z.number().nullable(),
      }),
      output: z.object({
        titles: z.array(z.string()),
        stopped: z.string().nullable(),
        steps: z.number().nullable(),
      }),
      events: {
        ADD: z.object({ title: z.string() }),
        TOGGLE: z.object({ id: z.number() }),
        NOTHING: z.object({}),
        QUIT: z.object({}),
      },
    }),
  });

  return agent.createMachine({
    context: () => ({ todos: [], stopped: null, steps: null }),
    initial: "planning",
    states: {
      planning: {
        invoke: {
          id: "plan1",
          src: "agent.plan",
          input: () => ({
            model: "quick",
            prompt: "Manage the todo list.",
            allowedEvents: ["ADD", "TOGGLE", "NOTHING", "QUIT"] as const,
            stopOn: ["NOTHING"] as const,
            maxSteps: 5,
          }),
          onDone: ({ context, output }) => ({
            target: "done",
            context: { ...context, stopped: output.stopped, steps: output.steps.length },
          }),
        },
        on: {
          ADD: ({ context, event }) => ({
            context: { ...context, todos: [...context.todos, event.title] },
          }),
          // Guard: only toggles an existing index.
          TOGGLE: ({ context, event }) =>
            event.id < context.todos.length ? { context } : undefined,
          NOTHING: {},
          QUIT: { target: "done" },
        },
      },
      done: {
        type: "final",
        output: ({ context }) => ({
          titles: context.todos,
          stopped: context.stopped,
          steps: context.steps,
        }),
      },
    },
  });
}

// A machine whose plan state has no legal machine events at all — the plan
// terminates 'no-legal-events' before any model call.
function createDeadEndAgent() {
  const agent = setupAgent({
    schemas: createAgentSchemas({
      context: z.object({ stopped: z.string().nullable() }),
      output: z.object({ stopped: z.string().nullable() }),
      events: { ADD: z.object({}) },
    }),
  });
  return agent.createMachine({
    context: () => ({ stopped: null }),
    initial: "planning",
    states: {
      planning: {
        invoke: {
          id: "plan1",
          src: "agent.plan",
          input: () => ({ model: "quick", allowedEvents: ["ADD"] as const }),
          onDone: ({ output }) => ({ target: "done", context: { stopped: output.stopped } }),
        },
        // No `on` handlers: nothing is legal.
      },
      done: { type: "final", output: ({ context }) => ({ stopped: context.stopped }) },
    },
  });
}

function scriptedDecide(script: ChosenEvent[]) {
  const requests: { id: string; events: string[]; prompt?: string }[] = [];
  let index = 0;
  const decide: AgentDecisionExecutor = async (request) => {
    requests.push({
      id: request.id,
      events: request.events.map((event) => event.type),
      prompt: request.prompt,
    });
    const event = script[index++];
    if (!event) {
      throw new Error("scripted decide ran out of events");
    }
    return { event };
  };
  return { decide, requests };
}

function executors(decide: AgentDecisionExecutor): AgentRequestExecutors {
  return { decide, generateText: async () => ({ output: {} }) };
}

// Drives an agent machine to completion through the step loop.
async function runViaSteps(
  machine: ReturnType<typeof createTodoAgent>,
  decide: AgentDecisionExecutor,
) {
  let step = initialAgentStep(machine);
  while (!step.done) {
    step = await resolveAgentRequests(machine, step, executors(decide));
  }
  return step;
}

describe("agent.plan on the step path", () => {
  test("drives a plan with a decide-only partial executor set (no generateText, no cast)", async () => {
    const machine = createTodoAgent();
    const script: ChosenEvent[] = [{ type: "ADD", title: "milk" }, { type: "NOTHING" }];
    let index = 0;
    // A plan step consumes only `decide`; the Partial<AgentRequestExecutors>
    // entry point accepts this object with no generateText and no cast.
    let step = initialAgentStep(machine);
    while (!step.done) {
      step = await resolveAgentRequests(machine, step, {
        decide: async () => ({ event: script[index++]! }),
      });
    }
    expect(step.snapshot.output).toMatchObject({
      titles: ["milk"],
      stopped: "stop-event",
    });
  });

  test("re-surfaces a plan request with candidates, applied trail, and budget", async () => {
    const machine = createTodoAgent();
    const step = initialAgentStep(machine);

    const [request] = step.requests;
    expect(request?.kind).toBe("plan");
    const plan = request as AgentPlanRequest;
    expect(plan.id).toBe("plan1");
    expect(plan.src).toBe("agent.plan");
    expect(plan.applied).toEqual([]);
    expect(plan.stepsRemaining).toBe(5);
    // Machine candidates plus the reserved done move.
    expect(plan.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["ADD", "TOGGLE", "NOTHING", "QUIT", "agent.plan.done"]),
    );
    expect(plan.input.model).toBe("quick");
    expect(plan.input.maxSteps).toBe(5);

    // Apply one event; the NEXT step re-surfaces the plan with an updated trail.
    const { decide } = scriptedDecide([{ type: "ADD", title: "milk" }]);
    const next = await resolveAgentRequests(machine, step, executors(decide));
    const nextPlan = next.requests.find((r) => r.kind === "plan") as AgentPlanRequest;
    expect(nextPlan).toBeDefined();
    expect(nextPlan.applied).toEqual([{ type: "ADD", title: "milk" }]);
    expect(nextPlan.stepsRemaining).toBe(4);
  });

  test("the plan ledger lands in the persisted snapshot at children.<id>.snapshot.context", async () => {
    const machine = createTodoAgent();
    const step = initialAgentStep(machine);

    const { decide } = scriptedDecide([{ type: "ADD", title: "milk" }]);
    const next = await resolveAgentRequests(machine, step, executors(decide));

    // The applied trail + remaining budget serialize for free as the plan
    // child's own createLogic snapshot context.
    const persisted = machine.getPersistedSnapshot(next.snapshot as never) as unknown as {
      children: Record<string, { snapshot: { context?: unknown } }>;
    };
    expect(persisted.children.plan1?.snapshot.context).toMatchObject({
      applied: [{ type: "ADD", title: "milk" }],
      stepsRemaining: 4, // maxSteps (5) - 1 applied
      stopped: null,
    });
  });

  test("appends the applied trail to each step's decision prompt", async () => {
    const machine = createTodoAgent();
    const { decide, requests } = scriptedDecide([
      { type: "ADD", title: "milk" },
      { type: "NOTHING" },
    ]);
    await runViaSteps(machine, decide);

    expect(requests[0]!.prompt).toContain("Manage the todo list.");
    expect(requests[0]!.prompt).toContain("agent.plan.done");
    expect(requests[0]!.events).toContain("agent.plan.done");
    expect(requests[1]!.prompt).toContain("Events already applied in this plan");
    expect(requests[1]!.prompt).toContain('"milk"');
    // Per-step decision ids are namespaced by trail length.
    expect(requests[0]!.id).toBe("plan1[0]");
    expect(requests[1]!.id).toBe("plan1[1]");
  });

  // Parity: identical machine + scripted decide, driven via runAgent AND via
  // the step loop, must land on identical final output.
  const scenarios: { name: string; script: ChosenEvent[] }[] = [
    {
      name: "stop-event ends the plan (NOTHING)",
      script: [{ type: "ADD", title: "milk" }, { type: "ADD", title: "eggs" }, { type: "NOTHING" }],
    },
    {
      name: "the built-in done move ends the plan",
      script: [{ type: "ADD", title: "only" }, { type: "agent.plan.done" }],
    },
    {
      name: "maxSteps caps the plan",
      script: [
        { type: "ADD", title: "1" },
        { type: "ADD", title: "2" },
        { type: "ADD", title: "3" },
        { type: "ADD", title: "4" },
        { type: "ADD", title: "5" },
      ],
    },
    {
      name: "an applied event that exits the state cancels the invoke (QUIT)",
      script: [{ type: "ADD", title: "last" }, { type: "QUIT" }],
    },
  ];

  for (const { name, script } of scenarios) {
    test(`parity with runAgent: ${name}`, async () => {
      const viaRun = await runAgent(createTodoAgent(), {
        executors: executors(scriptedDecide(script).decide),
      });
      const viaSteps = await runViaSteps(createTodoAgent(), scriptedDecide(script).decide);

      expect(viaRun.status).toBe("done");
      if (viaRun.status !== "done") throw new Error("expected done");
      expect(viaSteps.snapshot.output).toEqual(viaRun.output);
    });
  }

  test("parity: guard-rejected step retries with rejected-by-guard feedback", async () => {
    // First choice toggles a missing index (guard rejects → retry), then recovers.
    const script: ChosenEvent[] = [
      { type: "ADD", title: "one" },
      { type: "TOGGLE", id: 9 }, // rejected by guard
      { type: "NOTHING" },
    ];
    const buildDecide = () => {
      let call = 0;
      const decide: AgentDecisionExecutor = async () => {
        call += 1;
        if (call === 1) return { event: { type: "ADD", title: "one" } };
        if (call === 2) return { event: { type: "TOGGLE", id: 9 } };
        return { event: { type: "NOTHING" } };
      };
      return decide;
    };
    void script;

    const viaRun = await runAgent(createTodoAgent(), { executors: executors(buildDecide()) });
    const viaSteps = await runViaSteps(createTodoAgent(), buildDecide());

    expect(viaRun.status).toBe("done");
    if (viaRun.status !== "done") throw new Error("expected done");
    expect(viaSteps.snapshot.output).toEqual(viaRun.output);
    expect(viaSteps.snapshot.output).toMatchObject({ titles: ["one"], stopped: "stop-event" });
  });

  test("parity: no-legal-events terminates before any model call", async () => {
    const machine = createDeadEndAgent();
    let calls = 0;
    const decide: AgentDecisionExecutor = async () => {
      calls += 1;
      return { event: { type: "ADD" } };
    };

    const viaRun = await runAgent(createDeadEndAgent(), { executors: executors(decide) });
    const settled = await (async () => {
      let step = initialAgentStep(machine);
      while (!step.done) {
        step = await resolveAgentRequests(machine, step, executors(decide));
      }
      return step;
    })();

    expect(viaRun.status).toBe("done");
    if (viaRun.status !== "done") throw new Error("expected done");
    expect(settled.snapshot.output).toEqual({ stopped: "no-legal-events" });
    expect(viaRun.output).toEqual({ stopped: "no-legal-events" });
    // No decision was ever requested on either path.
    expect(calls).toBe(0);
  });

  test("mid-plan snapshot survives a JSON round-trip and finishes identically", async () => {
    const machine = createTodoAgent();
    const script: ChosenEvent[] = [
      { type: "ADD", title: "milk" },
      { type: "ADD", title: "eggs" },
      { type: "ADD", title: "bread" },
      { type: "NOTHING" },
    ];

    // Baseline: run straight through with no persistence.
    const baseline = await runViaSteps(createTodoAgent(), scriptedDecide(script).decide);

    // Persisting host: after EACH event, serialize the step to JSON via
    // machine.getPersistedSnapshot, then reload from that JSON before continuing.
    const { decide } = scriptedDecide(script);
    let step = initialAgentStep(machine);
    let reloads = 0;
    while (!step.done) {
      step = await resolveAgentRequests(machine, step, executors(decide));
      if (step.done) break;
      // Serialize → JSON string → parse → rehydrate → rebuild the step.
      const persistedJson = JSON.stringify(machine.getPersistedSnapshot(step.snapshot as never));
      const restored = createActor(machine, {
        snapshot: JSON.parse(persistedJson) as never,
      }).getSnapshot();
      step = {
        snapshot: restored,
        actions: [],
        requests: getAgentRequests(machine, [], restored),
        done: restored.status === "done",
      } as typeof step;
      reloads += 1;
    }

    expect(reloads).toBeGreaterThan(0);
    expect(step.snapshot.output).toEqual(baseline.snapshot.output);
    expect(step.snapshot.output).toMatchObject({
      titles: ["milk", "eggs", "bread"],
      stopped: "stop-event",
      steps: 4,
    });
  });
});

describe("resolveAgentRequests concurrency", () => {
  // Two parallel regions, each invoking a text request, then joining.
  function createParallelTextAgent() {
    const agent = setupAgent({
      schemas: createAgentSchemas({
        // `log` records apply ORDER (each region appends on its own onDone), so
        // the request-array-order guarantee is directly observable.
        context: z.object({ log: z.array(z.string()) }),
        output: z.object({ log: z.array(z.string()) }),
      }),
      actorSources: {
        writeA: createTextLogic({
          schemas: { input: z.object({}), output: z.string() },
          model: "quick",
          prompt: "a",
        }),
        writeB: createTextLogic({
          schemas: { input: z.object({}), output: z.string() },
          model: "quick",
          prompt: "b",
        }),
      },
    });
    return agent.createMachine({
      context: () => ({ log: [] }),
      type: "parallel",
      states: {
        regionA: {
          initial: "working",
          states: {
            working: {
              invoke: {
                id: "writeA",
                src: "writeA",
                input: () => ({}),
                onDone: ({ context, event }) => ({
                  target: "done",
                  context: { log: [...context.log, event.output as string] },
                }),
              },
            },
            done: { type: "final" },
          },
        },
        regionB: {
          initial: "working",
          states: {
            working: {
              invoke: {
                id: "writeB",
                src: "writeB",
                input: () => ({}),
                onDone: ({ context, event }) => ({
                  target: "done",
                  context: { log: [...context.log, event.output as string] },
                }),
              },
            },
            done: { type: "final" },
          },
        },
      },
    });
  }

  test("starts both executors before either output applies; outputs apply in declared order", async () => {
    const machine = createParallelTextAgent();
    const started: string[] = [];
    // Deferred promises so we can observe both executors starting before any resolves.
    let releaseA!: () => void;
    let releaseB!: () => void;
    const gateA = new Promise<void>((r) => (releaseA = r));
    const gateB = new Promise<void>((r) => (releaseB = r));

    const generateText: AgentRequestExecutors["generateText"] = async (request) => {
      const id = request.prompt === "a" ? "A" : "B";
      started.push(id);
      await (id === "A" ? gateA : gateB);
      return { output: id };
    };

    let step = initialAgentStep(machine);
    // writeA precedes writeB in the request array.
    expect(step.requests.map((r) => r.id)).toEqual(["writeA", "writeB"]);

    const pending = resolveAgentRequests(machine, step, { generateText });
    // Give both executors a tick to start.
    await new Promise((r) => setTimeout(r, 0));
    // Both executors started BEFORE either output applied.
    expect(started.sort()).toEqual(["A", "B"]);

    // Release in REVERSE completion order; outputs must still apply in
    // request-array order (A before B).
    releaseB();
    releaseA();
    step = await pending;

    // Applied in declared order regardless of which model call finished first.
    expect(step.snapshot.context.log).toEqual(["A", "B"]);
  });

  test("both region executors run before the first output applies (concurrent by default)", async () => {
    const machine = createParallelTextAgent();
    const started: string[] = [];
    // Hold the FIRST region's executor open; if resolution were sequential the
    // second executor could not start. Under the default concurrent semantics
    // both start immediately.
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => (releaseFirst = r));

    let call = 0;
    const generateText: AgentRequestExecutors["generateText"] = async (request) => {
      const id = request.prompt === "a" ? "A" : "B";
      started.push(id);
      if (++call === 1) {
        await gate; // hold the first executor open
      }
      return { output: `text-${id}` };
    };

    const step = initialAgentStep(machine);
    const pending = resolveAgentRequests(machine, step, { generateText });
    await new Promise((r) => setTimeout(r, 0));
    // Concurrent: BOTH executors started even though the first is still open.
    expect(started.sort()).toEqual(["A", "B"]);

    releaseFirst();
    await pending;
  });
});
