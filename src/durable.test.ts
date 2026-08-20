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
