import { describe, expect, test } from "vitest";
import { z } from "zod";
import { initialTransition, transition, type AnyMachineSnapshot, type EventObject } from "xstate";
import { createAgentSchemas, createTextLogic, runAgent, setupAgent } from "./index.js";
import {
  executeAgentRequest,
  createReplayEntry,
  getAgentEffects,
  initEntry,
  PLAN_DONE_EVENT_TYPE,
  replay,
  resolveDecision,
  type AgentDecisionRequest,
  type AgentPlanRequest,
  type AgentLogEntry,
} from "./steps/index.js";
import type { AgentDecisionExecutor, AgentRequestExecutors, ChosenEvent } from "./index.js";

// ───────────────────────────────────────────────────────────────────────────
// The thin-loop plan driver.
//
// The step-envelope `resolveAgentRequests`/`resolvePlanRequest` helpers are gone
// from the public surface. Driving an `agent.plan` invoke is now the HOST's job,
// over the append-only journal: a `plan` AgentEffect re-surfaces each frontier
// (candidates recomputed from the live snapshot), and the host resolves ONE
// decision per step, journals the chosen MACHINE event, and completes the plan
// by journaling the invoke's `xstate.done.actor` event when the done-move /
// a stopOn event / the budget / no-legal-events terminates it.
//
// What moved to host responsibility (was baked into `resolvePlanRequest`, now
// this file's helpers): (1) the per-step decision request — id `plan1[n]`, the
// applied trail appended to the prompt, the done-move hint — see
// `planStepDecisionRequest`; (2) tracking the applied trail. A `plan` effect's
// re-surfaced `applied`/`stepsRemaining` are NOT reconstructed under pure fold
// (the invoke child's ledger context only advances when the ENVELOPE mutates it;
// the thin loop journals bare machine events instead), so the host derives the
// trail from the journal itself — `reconstructApplied` below. Everything else
// (one decision per step, guard-gated retries, the four stop reasons, crash-safe
// mid-plan resume) is re-pinned here against the thin loop.
// ───────────────────────────────────────────────────────────────────────────

// The plan's applied trail, reconstructed from the journal: for these
// single-plan machines it is every journaled machine event (drop the reserved
// init entry and any xstate.* completion/timer events). A machine that also
// takes unrelated external events would scope this to the plan's active window.
function reconstructApplied(entries: readonly AgentLogEntry[]): ChosenEvent[] {
  return entries
    .slice(1)
    .map((entry) => entry.event)
    .filter((event) => !event.type.startsWith("xstate.")) as ChosenEvent[];
}

// The invoke-completion event that fires the plan state's `onDone` — the host
// feeds the plan's `{ steps, stopped }` output back exactly like a text result.
function planDoneEvent(id: string, steps: ChosenEvent[], stopped: string): EventObject {
  return {
    type: "xstate.done.actor",
    output: { steps, stopped },
    actorId: id,
  } as EventObject;
}

// Lowers a re-surfaced plan request into the per-step decision request (mirrors
// the old createRunAgentPlanLogic/planStepDecisionRequest recipe): id namespaced
// by trail length, the trail appended to the prompt, and the built-in done-move
// hint. This cosmetic shaping is now host recipe, not core.
function planStepDecisionRequest(
  request: AgentPlanRequest,
  applied: ChosenEvent[],
): AgentDecisionRequest {
  const trail =
    applied.length === 0
      ? ""
      : `\n\nEvents already applied in this plan, in order:\n${applied
          .map((step) => JSON.stringify(step))
          .join("\n")}\nContinue from here; do not repeat applied events.`;
  const doneHint = `\n\nWhen the request is fully handled (or no action is needed), choose '${PLAN_DONE_EVENT_TYPE}'.`;
  return {
    kind: "decision",
    id: `${request.id}[${applied.length}]`,
    model: request.input.model,
    system: request.input.system,
    prompt: `${request.input.prompt ?? ""}${trail}${doneHint}`,
    messages: request.input.messages,
    events: request.events,
    attempts: [],
    temperature: request.input.temperature,
    maxOutputTokens: request.input.maxOutputTokens,
    topP: request.input.topP,
    topK: request.input.topK,
    seed: request.input.seed,
    stopSequences: request.input.stopSequences,
    metadata: request.input.metadata,
  };
}

// Drives a single `agent.plan` invoke (id `planId`) to termination, folding each
// applied event into the journal. Reloads the frontier by REPLAYING the journal
// each step, so persisting `entries` between steps (see the mid-plan test) is
// crash-safe. `persist` runs after every journal append.
async function drivePlan(
  machine: any,
  planId: string,
  entries: AgentLogEntry[],
  decide: AgentDecisionExecutor,
  persist?: () => void | Promise<void>,
): Promise<void> {
  for (;;) {
    const { snapshot, effects } = replay(machine, entries);
    if ((snapshot as AnyMachineSnapshot).status !== "active") {
      return;
    }
    const planEffect = effects.find(
      (effect) => effect.kind === "plan" && effect.request.id === planId,
    );
    if (!planEffect || planEffect.kind !== "plan") {
      return; // the plan ended or an applied event exited its state (canceled).
    }
    const request = planEffect.request;
    const applied = reconstructApplied(entries);
    const maxSteps = request.input.maxSteps ?? 8;
    const stopOn = new Set<string>(request.input.stopOn ?? []);
    const machineEvents = request.events.filter((event) => event.type !== PLAN_DONE_EVENT_TYPE);

    const complete = async (stopped: string) => {
      entries.push(createReplayEntry(machine, entries, planDoneEvent(planId, applied, stopped)));
      await persist?.();
    };

    // Terminal pre-checks (no model call) — mirror runAgent's loop-top guards.
    if (applied.length >= maxSteps) {
      return complete("max-steps");
    }
    if (machineEvents.length === 0) {
      return complete("no-legal-events");
    }

    const chosen = await resolveDecision(planStepDecisionRequest(request, applied), decide, {
      canTake: (event) =>
        event.type === PLAN_DONE_EVENT_TYPE || stopOn.has(event.type)
          ? true
          : (snapshot as AnyMachineSnapshot).can(event as never),
    });

    if (chosen.type === PLAN_DONE_EVENT_TYPE) {
      return complete("done");
    }

    entries.push(createReplayEntry(machine, entries, chosen));
    await persist?.();

    if (stopOn.has(chosen.type)) {
      // The stopOn event was applied; complete the plan — unless it exited the
      // invoking state (which already canceled the invoke, so onDone never fires).
      const after = replay(machine, entries);
      const stillActive = after.effects.some(
        (effect) => effect.kind === "plan" && effect.request.id === planId,
      );
      if (stillActive) {
        entries.push(
          createReplayEntry(
            machine,
            entries,
            planDoneEvent(planId, reconstructApplied(entries), "stop-event"),
          ),
        );
        await persist?.();
      }
      return;
    }
  }
}

// Drives a whole machine to completion through the thin loop: resolve one
// frontier effect per fold, dispatching plans to `drivePlan`. `decide` backs
// every decision/plan; a text effect (none in these plan tests) would resolve
// with `executeAgentRequest`.
async function runViaEffects(
  machine: any,
  decide: AgentDecisionExecutor,
  persist?: (entries: AgentLogEntry[]) => void | Promise<void>,
): Promise<AnyMachineSnapshot> {
  const entries: AgentLogEntry[] = [initEntry(machine, undefined)];
  const runPersist = persist ? () => persist(entries) : undefined;

  for (;;) {
    const { snapshot, effects } = replay(machine, entries);
    if ((snapshot as AnyMachineSnapshot).status !== "active") {
      return snapshot as AnyMachineSnapshot;
    }
    for (const effect of effects) {
      if (effect.kind === "execute") {
        effect.exec();
      }
    }
    const pending = effects.find((effect) => effect.kind !== "execute");
    if (!pending) {
      return snapshot as AnyMachineSnapshot; // idle
    }
    if (pending.kind === "plan") {
      await drivePlan(machine, pending.request.id, entries, decide, runPersist);
      continue;
    }
    if (pending.kind === "decision") {
      const chosen = await resolveDecision(pending.request, decide, {
        canTake: (event) => (snapshot as AnyMachineSnapshot).can(event as never),
      });
      entries.push(createReplayEntry(machine, entries, chosen));
      await runPersist?.();
      continue;
    }
    throw new Error(`this plan host does not handle '${pending.kind}' effects.`);
  }
}

// A todo-list machine managed by one `agent.plan` invoke. Its final output
// records the plan's stop reason and step count (when onDone fires), so the
// SAME machine driven via runAgent and via the thin loop can be compared for
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

describe("agent.plan on the thin loop", () => {
  test("drives a plan with a decide-only executor to a stop-event finish", async () => {
    const machine = createTodoAgent();
    const script: ChosenEvent[] = [{ type: "ADD", title: "milk" }, { type: "NOTHING" }];
    let index = 0;
    const snapshot = await runViaEffects(machine, async () => ({ event: script[index++]! }));
    expect(snapshot.output).toMatchObject({
      titles: ["milk"],
      stopped: "stop-event",
    });
  });

  test("re-surfaces a plan effect with candidates and budget each frontier", () => {
    const machine = createTodoAgent();
    const entries: AgentLogEntry[] = [initEntry(machine, undefined)];

    // Frontier 0: the plan effect surfaces with the machine candidates plus the
    // reserved done move.
    let { snapshot, effects } = replay(machine, entries);
    let planEffect = effects.find((effect) => effect.kind === "plan");
    expect(planEffect?.kind).toBe("plan");
    const plan = (planEffect as Extract<typeof planEffect, { kind: "plan" }>).request;
    expect(plan.id).toBe("plan1");
    expect(plan.src).toBe("agent.plan");
    expect(plan.input.model).toBe("quick");
    expect(plan.input.maxSteps).toBe(5);
    expect(plan.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["ADD", "TOGGLE", "NOTHING", "QUIT", "agent.plan.done"]),
    );

    // Apply one event; the plan effect re-surfaces on the next frontier, and the
    // host derives the applied trail from the journal.
    entries.push(
      createReplayEntry(machine, entries, { type: "ADD", title: "milk" } as EventObject),
    );
    ({ snapshot, effects } = replay(machine, entries));
    planEffect = effects.find((effect) => effect.kind === "plan");
    expect(planEffect?.kind).toBe("plan");
    expect(reconstructApplied(entries)).toEqual([{ type: "ADD", title: "milk" }]);
    // NOTE: the re-surfaced effect's own `applied`/`stepsRemaining` are NOT
    // folded under pure replay — the host tracks the trail (see the module note).
    void snapshot;
  });

  test("the applied trail round-trips as plain JSON in the journal", async () => {
    const machine = createTodoAgent();
    const entries: AgentLogEntry[] = [initEntry(machine, undefined)];
    entries.push(
      createReplayEntry(machine, entries, { type: "ADD", title: "milk" } as EventObject),
    );

    // The journal is the durable artifact: it survives a full JSON round-trip.
    const round = JSON.parse(JSON.stringify(entries)) as AgentLogEntry[];
    expect(reconstructApplied(round)).toEqual([{ type: "ADD", title: "milk" }]);
    const { snapshot } = replay(machine, round);
    expect((snapshot as AnyMachineSnapshot).value).toBe("planning");
  });

  test("appends the applied trail to each step's decision prompt", async () => {
    const machine = createTodoAgent();
    const { decide, requests } = scriptedDecide([
      { type: "ADD", title: "milk" },
      { type: "NOTHING" },
    ]);
    await runViaEffects(machine, decide);

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
  // the thin loop, must land on identical final output.
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
      const viaLoop = await runViaEffects(createTodoAgent(), scriptedDecide(script).decide);

      expect(viaRun.status).toBe("done");
      if (viaRun.status !== "done") throw new Error("expected done");
      expect(viaLoop.output).toEqual(viaRun.output);
    });
  }

  test("parity: guard-rejected step retries with rejected-by-guard feedback", async () => {
    // First choice toggles a missing index (guard rejects → retry), then recovers.
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

    const viaRun = await runAgent(createTodoAgent(), { executors: executors(buildDecide()) });
    const viaLoop = await runViaEffects(createTodoAgent(), buildDecide());

    expect(viaRun.status).toBe("done");
    if (viaRun.status !== "done") throw new Error("expected done");
    expect(viaLoop.output).toEqual(viaRun.output);
    expect(viaLoop.output).toMatchObject({ titles: ["one"], stopped: "stop-event" });
  });

  test("parity: no-legal-events terminates before any model call", async () => {
    const machine = createDeadEndAgent();
    let calls = 0;
    const decide: AgentDecisionExecutor = async () => {
      calls += 1;
      return { event: { type: "ADD" } };
    };

    const viaRun = await runAgent(createDeadEndAgent(), { executors: executors(decide) });
    const settled = await runViaEffects(machine, decide);

    expect(viaRun.status).toBe("done");
    if (viaRun.status !== "done") throw new Error("expected done");
    expect(settled.output).toEqual({ stopped: "no-legal-events" });
    expect(viaRun.output).toEqual({ stopped: "no-legal-events" });
    // No decision was ever requested on either path.
    expect(calls).toBe(0);
  });

  test("mid-plan journal survives a JSON round-trip and finishes identically", async () => {
    const script: ChosenEvent[] = [
      { type: "ADD", title: "milk" },
      { type: "ADD", title: "eggs" },
      { type: "ADD", title: "bread" },
      { type: "NOTHING" },
    ];

    // Baseline: run straight through with no persistence.
    const baseline = await runViaEffects(createTodoAgent(), scriptedDecide(script).decide);

    // Persisting host: after EACH journal append, serialize the ENTIRE journal
    // to a JSON string and reload it in place — modeling a durable host that
    // crashes and resumes from the persisted log between every step. The trail
    // and frontier are both reconstructed from that log, so the run is
    // crash-safe by construction.
    const machine = createTodoAgent();
    const { decide } = scriptedDecide(script);
    let reloads = 0;
    const settled = await runViaEffects(machine, decide, (entries) => {
      const round = JSON.parse(JSON.stringify(entries)) as AgentLogEntry[];
      entries.splice(0, entries.length, ...round);
      reloads += 1;
    });

    expect(reloads).toBeGreaterThan(0);
    expect(settled.output).toEqual(baseline.output);
    expect(settled.output).toMatchObject({
      titles: ["milk", "eggs", "bread"],
      stopped: "stop-event",
      steps: 4,
    });
  });
});

describe("thin loop: concurrent text effects (host responsibility)", () => {
  // The old `resolveAgentRequests` resolved a step's parallel text requests with
  // `Promise.all` and applied outputs in request-array order. That concurrency
  // is now the host's to write: a frontier surfaces one `text` effect per
  // parallel region, and a host that wants them concurrent runs `Promise.all`
  // over the effect list and folds the outputs in effect-array order. These
  // tests re-pin those two guarantees against exactly that host recipe.

  // Two parallel regions, each invoking a text request, then joining.
  function createParallelTextAgent() {
    const agent = setupAgent({
      schemas: createAgentSchemas({
        // `log` records apply ORDER (each region appends on its own onDone), so
        // the effect-array-order guarantee is directly observable.
        context: z.object({ log: z.array(z.string()) }),
        output: z.object({ log: z.array(z.string()) }),
      }),
      actors: {
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

  // Resolve a `text` effect via the public `executeAgentRequest` resolver.
  function resolveText(effect: Extract<import("./steps/index.js").AgentEffect, { kind: "text" }>) {
    return (executors: Partial<AgentRequestExecutors>) =>
      executeAgentRequest(
        {
          kind: "text",
          id: effect.requestId,
          src: effect.request.name ?? "",
          input: effect.request,
          tools: effect.request.tools ?? {},
          events: [],
        },
        executors,
      );
  }

  test("starts both executors before either output applies; outputs apply in effect order", async () => {
    const machine = createParallelTextAgent();
    const started: string[] = [];
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

    const entries: EventObject[] = [initEntry(machine, undefined).event];
    let [snapshot, actions] = initialTransition(machine, undefined);
    const effects = getAgentEffects(machine, snapshot as AnyMachineSnapshot, actions, {
      history: entries,
    });
    const textEffects = effects.filter((effect) => effect.kind === "text");
    // writeA precedes writeB in the frontier's effect array (document order).
    expect(textEffects.map((effect) => (effect as any).request.prompt)).toEqual(["a", "b"]);

    // The host resolves them concurrently.
    const pending = Promise.all(
      textEffects.map((effect) => resolveText(effect as any)({ generateText })),
    );
    await new Promise((r) => setTimeout(r, 0));
    // Both executors started BEFORE either output applied.
    expect(started.sort()).toEqual(["A", "B"]);

    // Release in REVERSE completion order; outputs must still apply in
    // effect-array order (A before B).
    releaseB();
    releaseA();
    const outputs = await pending;
    for (let index = 0; index < textEffects.length; index++) {
      const done = (textEffects[index] as any).toDoneEvent(outputs[index]);
      entries.push(done);
      [snapshot, actions] = transition(machine, snapshot, done as never);
    }

    // Applied in effect-array order regardless of which model call finished first.
    expect((snapshot as any).context.log).toEqual(["A", "B"]);
  });

  test("both region executors run before the first output applies (concurrent by default)", async () => {
    const machine = createParallelTextAgent();
    const started: string[] = [];
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

    const entries: EventObject[] = [initEntry(machine, undefined).event];
    const [snapshot, actions] = initialTransition(machine, undefined);
    const effects = getAgentEffects(machine, snapshot as AnyMachineSnapshot, actions, {
      history: entries,
    });
    const textEffects = effects.filter((effect) => effect.kind === "text");

    const pending = Promise.all(
      textEffects.map((effect) => resolveText(effect as any)({ generateText })),
    );
    await new Promise((r) => setTimeout(r, 0));
    // Concurrent: BOTH executors started even though the first is still open.
    expect(started.sort()).toEqual(["A", "B"]);

    releaseFirst();
    await pending;
  });
});
