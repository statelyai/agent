import { describe, expect, test } from "vitest";
import { z } from "zod";
import { runDurableAgent } from "./durable.js";
import { setupAgent } from "./index.js";
import { AGENT_INIT_EVENT_TYPE } from "./effects.js";

// A draft/review/send machine: one model call, then a human approval wait
// (plain `on` transitions, no invoke), then final. The shape every durable
// host cares about: model work + a park + a resume.
function buildDraftMachine(counters: { modelCalls: number; entryActions: number }) {
  const agent = setupAgent({
    context: z.object({ draft: z.string().nullable() }),
    output: z.object({ draft: z.string() }),
    events: {
      APPROVE: z.object({}),
      REJECT: z.object({}),
    },
    requests: {
      draft: {
        schemas: { input: z.object({}), output: z.string() },
        model: "m",
        prompt: () => "write the draft",
      },
    },
  });

  return agent.createMachine({
    id: "durable-draft",
    context: { draft: null },
    initial: "drafting",
    states: {
      drafting: {
        entry: () => {
          counters.entryActions++;
        },
        invoke: {
          src: "draft",
          input: () => ({}),
          onDone: ({ output }) => ({ target: "review", context: { draft: output } }),
        },
      },
      review: {
        on: {
          APPROVE: { target: "sent" },
          REJECT: { target: "drafting" },
        },
      },
      sent: { type: "final", output: ({ context }) => ({ draft: context.draft ?? "" }) },
    },
  });
}

function makeExecutors(counters: { modelCalls: number }) {
  return {
    generateText: async () => {
      counters.modelCalls++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { output: "the draft" };
    },
  };
}

describe("runDurableAgent", () => {
  test("fresh run executes the model, journals the completion, and settles idle at the wait", async () => {
    const counters = { modelCalls: 0, entryActions: 0 };
    const machine = buildDraftMachine(counters);

    const result = await runDurableAgent(machine, {
      input: undefined,
      executors: makeExecutors(counters),
    });

    expect(result.status).toBe("idle");
    expect(counters.modelCalls).toBe(1);
    expect(result.entries[0]?.event.type).toBe(AGENT_INIT_EVENT_TYPE);
    expect(result.entries[1]?.event.type).toBe("xstate.done.actor");
    expect(result.entries).toHaveLength(2);
  });

  test("resume replays the journal without re-calling the model, then completes on the event", async () => {
    const counters = { modelCalls: 0, entryActions: 0 };
    const machine = buildDraftMachine(counters);
    const executors = makeExecutors(counters);

    const idle = await runDurableAgent(machine, { executors });
    expect(idle.status).toBe("idle");
    expect(counters.modelCalls).toBe(1);

    // Simulate a new process: same journal, fresh call.
    const done = await runDurableAgent(machine, {
      entries: idle.entries,
      event: { type: "APPROVE" },
      executors,
    });

    expect(done.status).toBe("done");
    expect(done.status === "done" ? done.output : undefined).toEqual({ draft: "the draft" });
    // The journaled completion replayed; the model ran exactly once across both calls.
    expect(counters.modelCalls).toBe(1);
    expect(done.entries.map((entry) => entry.event.type)).toEqual([
      AGENT_INIT_EVENT_TYPE,
      "xstate.done.actor",
      "APPROVE",
    ]);
  });

  test("entry transition functions re-run when the journal folds — keep them pure", async () => {
    // v6 semantics: an `entry: () => {...}` function is part of the pure
    // transition, so it runs again every time the journal is folded (exactly
    // as under `replay()`). Durable machines must keep transition functions
    // pure; side effects belong in invoked/spawned actors.
    const counters = { modelCalls: 0, entryActions: 0 };
    const machine = buildDraftMachine(counters);
    const executors = makeExecutors(counters);

    const idle = await runDurableAgent(machine, { executors });
    expect(counters.entryActions).toBe(1);

    await runDurableAgent(machine, {
      entries: idle.entries,
      event: { type: "APPROVE" },
      executors,
    });
    // One live run + one replay fold.
    expect(counters.entryActions).toBe(2);
  });

  test("in-flight work at the crash point re-executes on resume", async () => {
    const counters = { modelCalls: 0, entryActions: 0 };
    const machine = buildDraftMachine(counters);
    const executors = makeExecutors(counters);

    const idle = await runDurableAgent(machine, { executors });
    // Drop the completion: the journal now looks like a crash mid-model-call.
    const crashed = idle.entries.slice(0, 1);

    const resumed = await runDurableAgent(machine, {
      entries: crashed,
      event: { type: "APPROVE" },
      executors,
    });

    // The model re-ran (its result was lost with the crash) and the run completed.
    expect(counters.modelCalls).toBe(2);
    expect(resumed.status).toBe("done");
  });

  test("rejection loops re-enter the invoke: each occurrence executes once, replays suppressed", async () => {
    const counters = { modelCalls: 0, entryActions: 0 };
    const machine = buildDraftMachine(counters);
    const executors = makeExecutors(counters);

    const idle1 = await runDurableAgent(machine, { executors });
    const idle2 = await runDurableAgent(machine, {
      entries: idle1.entries,
      event: { type: "REJECT" },
      executors,
    });
    expect(idle2.status).toBe("idle");
    // REJECT re-entered `drafting`: a second live model call.
    expect(counters.modelCalls).toBe(2);

    const done = await runDurableAgent(machine, {
      entries: idle2.entries,
      event: { type: "APPROVE" },
      executors,
    });
    expect(done.status).toBe("done");
    // Both journaled completions replayed; still two calls total.
    expect(counters.modelCalls).toBe(2);
  });

  test("onEntry streams appended entries for incremental persistence", async () => {
    const counters = { modelCalls: 0, entryActions: 0 };
    const machine = buildDraftMachine(counters);

    const streamed: string[] = [];
    const result = await runDurableAgent(machine, {
      executors: makeExecutors(counters),
      onEntry: (entry) => streamed.push(entry.event.type),
    });

    expect(streamed).toEqual(result.entries.map((entry) => entry.event.type));
  });
});

// A reminder machine: drafting (model call) → grace period (`after`) → sent,
// with NUDGE escaping the wait early. Exercises both timer modes.
function buildTimerMachine(counters: { modelCalls: number }) {
  const agent = setupAgent({
    context: z.object({ draft: z.string().nullable() }),
    output: z.object({ draft: z.string() }),
    events: { NUDGE: z.object({}) },
    requests: {
      draft: {
        schemas: { input: z.object({}), output: z.string() },
        model: "m",
        prompt: () => "write it",
      },
    },
  });
  return agent.createMachine({
    id: "timed-draft",
    context: { draft: null },
    initial: "drafting",
    states: {
      drafting: {
        invoke: {
          src: "draft",
          input: () => ({}),
          onDone: ({ output }) => ({ target: "grace", context: { draft: output } }),
        },
      },
      grace: {
        after: { 30: { target: "sent" } },
        on: { NUDGE: { target: "sent" } },
      },
      sent: { type: "final", output: ({ context }) => ({ draft: context.draft ?? "" }) },
    },
  });
}

describe("runDurableAgent timers", () => {
  test("live mode: the after() timer fires in-process, is journaled, and replays without re-arming", async () => {
    const counters = { modelCalls: 0 };
    const machine = buildTimerMachine(counters);
    const executors = makeExecutors(counters);

    const done = await runDurableAgent(machine, { executors });
    expect(done.status).toBe("done");
    const types = done.entries.map((entry) => entry.event.type);
    expect(types).toContain("xstate.timer");

    // Resume from the complete journal: replays instantly to done — the model
    // is not re-called and no timer is re-armed (the run would otherwise hang
    // or take another 30ms).
    const started = Date.now();
    const replayed = await runDurableAgent(machine, { entries: done.entries, executors });
    expect(replayed.status).toBe("done");
    expect(counters.modelCalls).toBe(1);
    expect(Date.now() - started).toBeLessThan(25);
  });

  test("external mode: settles idle with pendingTimers; the host's timer event completes the run", async () => {
    const counters = { modelCalls: 0 };
    const machine = buildTimerMachine(counters);
    const executors = makeExecutors(counters);

    const idle = await runDurableAgent(machine, { executors, timers: "external" });
    expect(idle.status).toBe("idle");
    if (idle.status !== "idle") throw new Error("unreachable");
    expect(idle.pendingTimers).toHaveLength(1);
    expect(idle.pendingTimers[0]!.delayMs).toBe(30);

    // The host's scheduler fires later, in a fresh process:
    const done = await runDurableAgent(machine, {
      entries: idle.entries,
      event: { type: "xstate.timer", id: idle.pendingTimers[0]!.id } as never,
      executors,
      timers: "external",
    });
    expect(done.status).toBe("done");
    expect(counters.modelCalls).toBe(1);
  });

  test("external mode: an event exiting the delayed state cancels the timer; a stale firing is a no-op", async () => {
    const counters = { modelCalls: 0 };
    const machine = buildTimerMachine(counters);
    const executors = makeExecutors(counters);

    const idle = await runDurableAgent(machine, { executors, timers: "external" });
    if (idle.status !== "idle") throw new Error("expected idle");
    const timerId = idle.pendingTimers[0]!.id;

    // Human nudges before the grace period elapses.
    const done = await runDurableAgent(machine, {
      entries: idle.entries,
      event: { type: "NUDGE" },
      executors,
      timers: "external",
    });
    expect(done.status).toBe("done");

    // The host's alarm still fires (at-least-once): stale firing is ignored.
    const after = await runDurableAgent(machine, {
      entries: done.entries,
      event: { type: "xstate.timer", id: timerId } as never,
      executors,
      timers: "external",
    });
    expect(after.status).toBe("done");
    expect(counters.modelCalls).toBe(1);
  });
});

describe("runDurableAgent timer/idle interplay", () => {
  test("live mode: isIdle settling a delayed wait state disarms the timer and reports it", async () => {
    // The 'wait for human, auto-proceed after timeout' pattern: the state is
    // an isIdle wait AND carries an after(...). Settling idle must not leak
    // the armed setTimeout (it would hold the process open and fire into a
    // discarded mailbox).
    const agent = setupAgent({
      context: z.object({}),
      events: { APPROVE: z.object({}) },
    });
    const machine = agent.createMachine({
      id: "idle-timer",
      context: {},
      initial: "waiting",
      states: {
        waiting: {
          tags: ["awaiting-user"],
          after: { 60_000: { target: "timedOut" } },
          on: { APPROVE: { target: "done" } },
        },
        timedOut: { type: "final" },
        done: { type: "final" },
      },
    });

    const started = Date.now();
    const idle = await runDurableAgent(machine, {
      isIdle: (snapshot) => snapshot.hasTag("awaiting-user"),
    });
    // Settles immediately — not held open by the 60s timer.
    expect(Date.now() - started).toBeLessThan(1000);
    expect(idle.status).toBe("idle");
    if (idle.status !== "idle") throw new Error("unreachable");
    // The disarmed timer is still reported, so a host can schedule the
    // auto-proceed wake-up; a resume re-arms it (firing was never journaled).
    expect(idle.pendingTimers).toEqual([
      { id: expect.stringContaining("xstate.after"), delayMs: 60_000 },
    ]);
  });
});
