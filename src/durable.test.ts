import { describe, expect, test } from "vitest";
import { createActor, createAsyncLogic } from "xstate";
import { z } from "zod";
import { runDurableAgent } from "./durable.js";
import { provideExecutors, runAgent, setupAgent } from "./index.js";
import type { AgentLogEntry } from "./event-log-store.js";
import {
  AGENT_INIT_EVENT_TYPE,
  AgentReplayDivergenceError,
  createReplayEntry,
  getLogExecutionId,
  replay,
} from "./effects.js";

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
    // The live frontier, plus the shadow pure fold that derives the entries'
    // verification hashes from the UNBOUND machine.
    expect(counters.entryActions).toBe(2);

    await runDurableAgent(machine, {
      entries: idle.entries,
      event: { type: "APPROVE" },
      executors,
    });
    // Plus the resume's durable journal fold and the pure fold of its strict
    // verification check (which also seeds that leg's shadow fold).
    expect(counters.entryActions).toBe(4);
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

  test("appended entries carry verification hashes matching a pure fold of the same log", async () => {
    const counters = { modelCalls: 0, entryActions: 0 };
    const machine = buildDraftMachine(counters);
    const executors = makeExecutors(counters);

    const idle1 = await runDurableAgent(machine, { executors });
    const idle2 = await runDurableAgent(machine, {
      entries: idle1.entries,
      event: { type: "REJECT" },
      executors,
    });
    const done = await runDurableAgent(machine, {
      entries: idle2.entries,
      event: { type: "APPROVE" },
      executors,
    });
    expect(done.status).toBe("done");
    // init, done.actor, REJECT, done.actor, APPROVE
    expect(done.entries).toHaveLength(5);

    // (a1) Strict replay accepts every recorded hash.
    expect(() => replay(machine, done.entries, { verify: "strict" })).not.toThrow();

    // (a2) The hashes equal what a pure `createReplayEntry` fold records for
    // the same log — byte-identical, entry by entry.
    const rebuilt: typeof done.entries = [];
    for (const entry of done.entries) {
      rebuilt.push(
        createReplayEntry(machine, rebuilt, entry.event, {
          id: entry.id,
          recordedAt: entry.recordedAt,
          ...(entry.metadata !== undefined ? { metadata: entry.metadata } : {}),
        }),
      );
    }
    expect(done.entries.map((entry) => entry.verification)).toEqual(
      rebuilt.map((entry) => entry.verification),
    );
    for (const entry of done.entries) {
      expect(entry.verification?.stateHash).toMatch(/^[0-9a-f]+$/);
    }
  });

  test("verification is on by default", async () => {
    const counters = { modelCalls: 0, entryActions: 0 };
    const machine = buildDraftMachine(counters);

    const result = await runDurableAgent(machine, { executors: makeExecutors(counters) });

    expect(result.entries.every((entry) => entry.verification !== undefined)).toBe(true);
  });

  test("verification: false omits the hashes", async () => {
    const counters = { modelCalls: 0, entryActions: 0 };
    const machine = buildDraftMachine(counters);

    const result = await runDurableAgent(machine, {
      executors: makeExecutors(counters),
      verification: false,
    });

    expect(result.entries.every((entry) => entry.verification === undefined)).toBe(true);
  });

  test("resuming from a tampered journal throws the replay verification error", async () => {
    const counters = { modelCalls: 0, entryActions: 0 };
    const machine = buildDraftMachine(counters);
    const executors = makeExecutors(counters);

    const idle = await runDurableAgent(machine, { executors });
    const tampered = idle.entries.map((entry, index) =>
      index === 1 ? { ...entry, event: { ...entry.event, output: "a different draft" } } : entry,
    );

    await expect(
      runDurableAgent(machine, {
        entries: tampered,
        event: { type: "APPROVE" },
        executors,
      }),
    ).rejects.toBeInstanceOf(AgentReplayDivergenceError);
  });
  test("a JSON round-tripped journal resumes to the same state as the original run", async () => {
    const counters = { modelCalls: 0, entryActions: 0 };
    const machine = buildDraftMachine(counters);
    const executors = makeExecutors(counters);

    const idle = await runDurableAgent(machine, { executors });
    expect(idle.snapshot.value).toBe("review");

    // A real host persists and re-reads the journal: plain JSON, no live refs.
    const persisted = JSON.parse(JSON.stringify(idle.entries)) as typeof idle.entries;
    const resumed = await runDurableAgent(machine, { entries: persisted, executors });

    expect(resumed.status).toBe("idle");
    // Journaled `xstate.done.actor` events name the ORIGINAL child session, so
    // the fold must rebind them onto the re-created child or the completion is
    // a no-op and the run stalls in `drafting`.
    expect(resumed.snapshot.value).toBe("review");
    expect(counters.modelCalls).toBe(1);
  });

  test("settling idle leaves no unhandled promise rejection", async () => {
    const counters = { modelCalls: 0, entryActions: 0 };
    const machine = buildDraftMachine(counters);

    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      const idle = await runDurableAgent(machine, { executors: makeExecutors(counters) });
      expect(idle.status).toBe("idle");
      // Let the rejection tracker run its checks.
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off("unhandledRejection", onRejection);
    }

    expect(rejections).toEqual([]);
  });

  test("onEntry receives the live snapshot each entry produced", async () => {
    const counters = { modelCalls: 0, entryActions: 0 };
    const machine = buildDraftMachine(counters);

    const seen: Array<{ type: string; value: unknown }> = [];
    const result = await runDurableAgent(machine, {
      executors: makeExecutors(counters),
      onEntry: (entry, snapshot) => seen.push({ type: entry.event.type, value: snapshot.value }),
    });

    expect(seen).toEqual([
      { type: AGENT_INIT_EVENT_TYPE, value: "drafting" },
      { type: "xstate.done.actor", value: "review" },
    ]);
    expect(seen.at(-1)?.value).toEqual(result.snapshot.value);
  });
});

// ─── projection-purity harness ───

/**
 * A machine that exercises every shape the durable adapter's mutable side
 * state tracks: a re-entrant invoke site (`note`) that occurs three times, a
 * second site (`settle`) that completes via `xstate.error.actor` and is
 * retried, and a final state.
 *
 * The `settle` actor's success/failure is a pure function of machine context
 * (`attempts`), never of an external counter — so a re-executed attempt
 * reproduces the recorded outcome exactly, which is what makes the
 * prefix-resume comparison meaningful.
 */
function buildLoopRetryMachine(counters: { executions: number }) {
  const flaky = createAsyncLogic({
    run: async ({ input }: { input: { attempt: number } }) => {
      counters.executions++;
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (input.attempt === 0) {
        throw new Error("flaky failed");
      }
      return `settled on attempt ${input.attempt}`;
    },
  });

  const agent = setupAgent({
    context: z.object({
      notes: z.array(z.string()),
      attempts: z.number(),
      settled: z.string().nullable(),
    }),
    output: z.object({ notes: z.array(z.string()), settled: z.string() }),
    actors: { flaky },
    requests: {
      note: {
        schemas: { input: z.object({ index: z.number() }), output: z.string() },
        model: "m",
        prompt: ({ input }) => `note ${input.index}`,
      },
    },
  });

  return agent.createMachine({
    id: "durable-projection",
    context: { notes: [], attempts: 0, settled: null },
    initial: "noting",
    states: {
      noting: {
        invoke: {
          id: "note",
          src: "note",
          input: ({ context }) => ({ index: context.notes.length }),
          onDone: ({ context, output }) =>
            context.notes.length >= 2
              ? { target: "settling", context: { notes: [...context.notes, output] } }
              : {
                  target: "noting",
                  reenter: true,
                  context: { notes: [...context.notes, output] },
                },
        },
      },
      settling: {
        invoke: {
          id: "settle",
          src: "flaky",
          input: ({ context }) => ({ attempt: context.attempts }),
          onDone: ({ output }) => ({ target: "settled", context: { settled: output } }),
          onError: ({ context }) => ({
            target: "settling",
            reenter: true,
            context: { attempts: context.attempts + 1 },
          }),
        },
      },
      settled: {
        type: "final",
        output: ({ context }) => ({ notes: context.notes, settled: context.settled ?? "" }),
      },
    },
  });
}

/**
 * Deterministic stand-in for the model host: the answer is a pure function of
 * the request's prompt, so the executors need no "positioning" for a resume —
 * whatever calls remain after a prefix return exactly what they returned in
 * the original run. `counters.executions` counts every live executor/actor
 * invocation.
 */
function makeDeterministicExecutors(counters: { executions: number }) {
  return {
    generateText: async (request: { prompt?: string }) => {
      counters.executions++;
      return { output: `drafted: ${request.prompt ?? ""}` };
    },
  };
}

const COMPLETION_TYPES = new Set(["xstate.done.actor", "xstate.error.actor"]);

/** An event with the child `sessionId` dropped — see the k=0 note below. */
function withoutSessionId(event: Record<string, unknown>) {
  const { sessionId: _sessionId, ...rest } = event;
  return rest;
}

describe("runDurableAgent — the journal is the whole state", () => {
  test("resuming from EVERY prefix reproduces the run, the journal, and the executor count", async () => {
    // ─── the recorded run ───
    const originalCounters = { executions: 0 };
    const originalMachine = buildLoopRetryMachine(originalCounters);
    const original = await runDurableAgent(originalMachine, {
      executors: makeDeterministicExecutors(originalCounters),
    });

    expect(original.status).toBe("done");
    const originalOutput = original.status === "done" ? original.output : undefined;
    expect(originalOutput).toEqual({
      notes: ["drafted: note 0", "drafted: note 1", "drafted: note 2"],
      settled: "settled on attempt 1",
    });
    // init, 3x note done, settle error, settle done.
    expect(original.entries.map((entry) => entry.event.type)).toEqual([
      AGENT_INIT_EVENT_TYPE,
      "xstate.done.actor",
      "xstate.done.actor",
      "xstate.done.actor",
      "xstate.error.actor",
      "xstate.done.actor",
    ]);
    // 3 model calls + 2 `settle` attempts.
    expect(originalCounters.executions).toBe(5);

    // A real host persists JSON, not live objects.
    const entries = JSON.parse(JSON.stringify(original.entries)) as typeof original.entries;

    for (let k = 0; k <= entries.length; k++) {
      const prefix = JSON.parse(JSON.stringify(entries.slice(0, k))) as typeof entries;
      const counters = { executions: 0 };
      const machine = buildLoopRetryMachine(counters);

      const resumed = await runDurableAgent(machine, {
        entries: prefix,
        executors: makeDeterministicExecutors(counters),
      });

      // (a) Same settled result.
      expect(resumed.status, `prefix ${k}: status`).toBe("done");
      expect(resumed.status === "done" ? resumed.output : undefined, `prefix ${k}: output`).toEqual(
        originalOutput,
      );

      // (b) Same journal. Entry ids are a deterministic function of the index
      // (`evt_<index>`), so they must match exactly, prefix or not.
      expect(
        resumed.entries.map((entry) => entry.id),
        `prefix ${k}: ids`,
      ).toEqual(entries.map((entry) => entry.id));
      expect(
        resumed.entries.map((entry) => withoutSessionId(entry.event as Record<string, unknown>)),
        `prefix ${k}: events`,
      ).toEqual(entries.map((entry) => withoutSessionId(entry.event as Record<string, unknown>)));
      expect(
        resumed.entries.map((entry) => entry.verification),
        `prefix ${k}: hashes`,
      ).toEqual(entries.map((entry) => entry.verification));
      if (k > 0) {
        // A resume inherits the journal's pinned `executionId`, which makes
        // child `sessionId`s a deterministic function of creation order — so
        // the completion events match byte for byte, `sessionId` included.
        // Only k=0 is exempt: with no init entry there is no journal to
        // inherit from, so a fresh `executionId` is minted.
        expect(
          resumed.entries.map((entry) => entry.event),
          `prefix ${k}: raw events`,
        ).toEqual(entries.map((entry) => entry.event));
      }

      // (c) The resumed journal verifies strictly under a pure fold.
      expect(
        () => replay(machine, resumed.entries, { verify: "strict" }),
        `prefix ${k}: strict replay`,
      ).not.toThrow();

      // (d) No journaled-completed invoke re-executed. Every completion in the
      // prefix was suppressed; every completion beyond it re-executed live
      // (that is the in-flight work a crash loses). This count, together with
      // (b), IS the observable projection check: the adapter's side state
      // (`suppressedChildren`, `startsSeen`, `liveInFlight`, `mailbox`) is
      // module-private and exposes nothing, so its purity is asserted through
      // what it decides — which invokes ran, and which journal it produced.
      const expectedExecutions = entries
        .slice(k)
        .filter((entry) => COMPLETION_TYPES.has(entry.event.type)).length;
      expect(counters.executions, `prefix ${k}: executions`).toBe(expectedExecutions);
    }
  });
});

describe("runDurableAgent callKey (idempotency key)", () => {
  // One invoke site re-entered three times: same site id, rising occurrence.
  const buildLoopMachine = () => {
    const agentSetup = setupAgent({
      context: z.object({ count: z.number(), answers: z.array(z.string()) }),
      input: z.object({}),
      output: z.object({ answers: z.array(z.string()) }),
      events: {},
      requests: {
        ask: {
          schemas: { input: z.object({ count: z.number() }), output: z.string() },
          model: "m",
          prompt: ({ input }) => `ask-${input.count}`,
        },
      },
    });
    return agentSetup.createMachine({
      id: "durable-loop",
      context: () => ({ count: 0, answers: [] }),
      initial: "asking",
      states: {
        asking: {
          invoke: {
            id: "ask",
            src: "ask",
            input: ({ context }) => ({ count: context.count }),
            onDone: ({ context, event }) => ({
              target: context.count >= 2 ? "done" : "asking",
              reenter: true,
              context: {
                count: context.count + 1,
                answers: [...context.answers, String(event.output)],
              },
            }),
          },
        },
        done: { type: "final", output: ({ context }) => ({ answers: context.answers }) },
      },
    });
  };

  const collectingExecutors = (keys: Array<string | undefined>) => ({
    generateText: async (request: { prompt?: unknown }, info?: { callKey?: string }) => {
      keys.push(info?.callKey);
      return { output: `ok:${String(request.prompt)}` };
    },
  });

  test("a looped invoke site gets #1, #2, #3", async () => {
    const machine = buildLoopMachine();
    const keys: Array<string | undefined> = [];

    const result = await runDurableAgent(machine, {
      input: {},
      executors: collectingExecutors(keys),
    });

    expect(result.status).toBe("done");
    const logId = getLogExecutionId(result.entries);
    expect(logId).toBeTypeOf("string");
    expect(keys).toEqual([`${logId}:ask#1`, `${logId}:ask#2`, `${logId}:ask#3`]);
  });

  test("callKey's site#occurrence half is the requestId replay derives for that call", async () => {
    const machine = buildLoopMachine();
    const keys: Array<string | undefined> = [];
    const result = await runDurableAgent(machine, {
      input: {},
      executors: collectingExecutors(keys),
    });

    // The prefix ending just before each recorded completion owes exactly the
    // call that was in flight at that point.
    const completions = result.entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.event.type === "xstate.done.actor");
    expect(completions).toHaveLength(3);
    completions.forEach(({ index }, n) => {
      const owed = replay(machine, result.entries.slice(0, index)).effects;
      expect(owed).toHaveLength(1);
      const effect = owed[0]!;
      if (effect.kind !== "text") throw new Error("expected an owed text effect");
      expect(effect.requestId).toBe(`ask#${n + 1}`);
      expect(keys[n]).toBe(`${getLogExecutionId(result.entries)}:${effect.requestId}`);
    });
  });

  test("crash resume re-executes the in-flight call with the SAME callKey", async () => {
    const machine = buildLoopMachine();
    const keys: Array<string | undefined> = [];
    const full = await runDurableAgent(machine, {
      input: {},
      executors: collectingExecutors(keys),
    });
    expect(full.status).toBe("done");

    // A crash after the first completion was persisted: the journal holds
    // [init, done#1] and the second call was still in flight.
    const crashed = JSON.parse(JSON.stringify(full.entries.slice(0, 2))) as AgentLogEntry[];
    const retried: Array<string | undefined> = [];
    const recovered = await runDurableAgent(machine, {
      entries: crashed,
      executors: collectingExecutors(retried),
    });

    expect(recovered.status).toBe("done");
    expect(retried[0]).toBe(keys[1]);
    expect(retried[0]).toContain(":ask#2");
    // The rest of the leg keeps counting from there.
    expect(retried).toEqual([keys[1], keys[2]]);
  });

  test("a resume keeps the journal's logId, and matches runAgent's key format", async () => {
    const machine = buildLoopMachine();
    const keys: Array<string | undefined> = [];
    const full = await runDurableAgent(machine, {
      input: {},
      executors: collectingExecutors(keys),
    });
    const logId = getLogExecutionId(full.entries);
    expect(logId).toBeTypeOf("string");

    const journal = JSON.parse(JSON.stringify(full.entries.slice(0, 2))) as AgentLogEntry[];
    expect(journal[0]!.metadata).toEqual({ executionId: logId });

    const resumedKeys: Array<string | undefined> = [];
    const resumed = await runDurableAgent(machine, {
      entries: journal,
      executors: collectingExecutors(resumedKeys),
    });

    expect(resumed.status).toBe("done");
    // Inherited, never re-minted.
    expect(getLogExecutionId(resumed.entries)).toBe(logId);
    expect(resumedKeys).toEqual([`${logId}:ask#2`, `${logId}:ask#3`]);
  });

  test("a journal whose init entry predates executionId mints no callKey", async () => {
    const machine = buildLoopMachine();
    const full = await runDurableAgent(machine, { input: {}, executors: collectingExecutors([]) });
    const legacy = JSON.parse(JSON.stringify(full.entries.slice(0, 2))) as AgentLogEntry[];
    delete legacy[0]!.metadata;

    const keys: Array<string | undefined> = [];
    const resumed = await runDurableAgent(machine, {
      entries: legacy,
      executors: collectingExecutors(keys),
    });

    expect(resumed.status).toBe("done");
    expect(keys.every((key) => key === undefined)).toBe(true);
  });

  test("runAgent resuming a durable journal mints the same keys", async () => {
    const machine = buildLoopMachine();
    const durableKeys: Array<string | undefined> = [];
    const full = await runDurableAgent(machine, {
      input: {},
      executors: collectingExecutors(durableKeys),
    });
    const logId = getLogExecutionId(full.entries);

    const runKeys: Array<string | undefined> = [];
    const resumed = await runAgent(machine, {
      events: JSON.parse(JSON.stringify(full.entries.slice(0, 2))) as AgentLogEntry[],
      executors: collectingExecutors(runKeys),
    });

    expect(resumed.status).toBe("done");
    // Same lineage id, same site#occurrence rule: one key space across hosts.
    expect(runKeys).toEqual([`${logId}:ask#2`, `${logId}:ask#3`]);
    expect(runKeys).toEqual(durableKeys.slice(1));
  });

  test("bare provideExecutors (no callKey option) leaves info.callKey undefined", async () => {
    const machine = buildLoopMachine();
    const keys: Array<string | undefined> = [];
    const actor = createActor(provideExecutors(machine, collectingExecutors(keys)), { input: {} });
    const done = new Promise<void>((resolve) => {
      actor.subscribe({ complete: () => resolve() });
    });
    actor.start();
    await done;

    expect(keys).toHaveLength(3);
    expect(keys.every((key) => key === undefined)).toBe(true);
  });
});

// ─── the `agent.generateText` builtin (no declared `requests.<name>` source) ───
// `provideExecutors` injects `outputSchema` into a builtin invoke's request,
// so the BOUND machine's actions differ structurally from the UNBOUND
// machine's. Durable verification must hash what `replay` hashes — the pure,
// unbound derivation — or every builtin-invoking machine diverges at entry 0.
function buildBuiltinLoopMachine() {
  const agent = setupAgent({
    context: z.object({ notes: z.array(z.string()), round: z.number() }),
    input: z.object({}),
    output: z.object({ notes: z.array(z.string()) }),
  });

  return agent.createMachine({
    id: "durable-builtin-loop",
    context: () => ({ notes: [], round: 0 }),
    initial: "thinking",
    states: {
      thinking: {
        invoke: {
          src: "agent.generateText",
          input: ({ context }) => ({ model: "m", prompt: `round ${context.round}` }),
          onDone: ({ context, event }) => ({
            target: context.round >= 1 ? "done" : "thinking",
            reenter: true,
            context: {
              notes: [...context.notes, String(event.output)],
              round: context.round + 1,
            },
          }),
        },
      },
      done: { type: "final", output: ({ context }) => ({ notes: context.notes }) },
    },
  });
}

describe("runDurableAgent — builtin `agent.generateText` invokes", () => {
  const scriptedExecutors = (calls: string[]) => ({
    generateText: async (request: { prompt?: string }) => {
      calls.push(request.prompt ?? "");
      return { output: `said: ${request.prompt}` };
    },
  });

  test("a builtin-invoking loop runs to done and its journal passes strict replay", async () => {
    const machine = buildBuiltinLoopMachine();
    const calls: string[] = [];

    const result = await runDurableAgent(machine, {
      input: {},
      executors: scriptedExecutors(calls),
    });

    expect(result.status).toBe("done");
    expect(result.status === "done" ? result.output : undefined).toEqual({
      notes: ["said: round 0", "said: round 1"],
    });
    expect(calls).toEqual(["round 0", "round 1"]);
    expect(result.entries.every((entry) => entry.verification !== undefined)).toBe(true);

    // (a) The recorded hashes are the ones a pure fold re-derives.
    expect(() => replay(machine, result.entries, { verify: "strict" })).not.toThrow();
  });

  test("a builtin-invoking loop resumes from a JSON round-tripped prefix", async () => {
    const machine = buildBuiltinLoopMachine();
    const original = await runDurableAgent(machine, {
      input: {},
      executors: scriptedExecutors([]),
    });
    const entries = JSON.parse(JSON.stringify(original.entries)) as AgentLogEntry[];

    for (let k = 1; k <= entries.length; k++) {
      const prefix = JSON.parse(JSON.stringify(entries.slice(0, k))) as AgentLogEntry[];
      const calls: string[] = [];
      const resumed = await runDurableAgent(machine, {
        entries: prefix,
        executors: scriptedExecutors(calls),
      });

      expect(resumed.status, `prefix ${k}: status`).toBe("done");
      expect(resumed.status === "done" ? resumed.output : undefined, `prefix ${k}: output`).toEqual(
        { notes: ["said: round 0", "said: round 1"] },
      );
      expect(
        resumed.entries.map((entry) => entry.verification),
        `prefix ${k}: hashes`,
      ).toEqual(entries.map((entry) => entry.verification));
      // Only the calls that were still in flight at the prefix re-executed.
      expect(calls.length, `prefix ${k}: live calls`).toBe(entries.length - k);
    }
  });
});

describe("runDurableAgent — journal intake and mixed verification", () => {
  test("a non-empty journal without the reserved init entry is rejected", async () => {
    const counters = { modelCalls: 0, entryActions: 0 };
    const machine = buildDraftMachine(counters);
    const executors = makeExecutors(counters);

    const idle = await runDurableAgent(machine, { executors });
    // The init entry lost (a truncated log, a host that stored only events):
    // re-indexed so it is contiguous, and therefore only the missing init
    // entry is wrong about it.
    const withoutInit = idle.entries.slice(1).map((entry, index) => ({ ...entry, index }));
    expect(withoutInit.length).toBeGreaterThan(0);

    await expect(
      runDurableAgent(machine, { entries: withoutInit, executors }),
    ).rejects.toMatchObject({ code: "invalid-journal" });
    // Nothing re-executed: the refusal happens before the machine is bound.
    expect(counters.modelCalls).toBe(1);
  });

  test("a journal recorded with verification:false resumes under the default (hash-free entries are skipped)", async () => {
    const counters = { modelCalls: 0, entryActions: 0 };
    const machine = buildDraftMachine(counters);
    const executors = makeExecutors(counters);

    const idle = await runDurableAgent(machine, { executors, verification: false });
    expect(idle.entries.every((entry) => entry.verification === undefined)).toBe(true);

    // Default (`verification: true`) resume of that hash-free journal.
    const done = await runDurableAgent(machine, {
      entries: idle.entries,
      event: { type: "APPROVE" },
      executors,
    });

    expect(done.status).toBe("done");
    expect(done.status === "done" ? done.output : undefined).toEqual({ draft: "the draft" });
    // The journal replayed (no second model call), and the entry this leg
    // appended IS hashed — a mixed journal from here on.
    expect(counters.modelCalls).toBe(1);
    expect(done.entries[0]!.verification).toBeUndefined();
    expect(done.entries.at(-1)!.verification?.stateHash).toMatch(/^[0-9a-f]+$/);
  });

  test("a mixed journal still throws when a HASHED entry is tampered with", async () => {
    const counters = { modelCalls: 0, entryActions: 0 };
    const machine = buildDraftMachine(counters);
    const executors = makeExecutors(counters);

    // Leg 1 unhashed, leg 2 (default) hashes what it appends.
    const unhashed = await runDurableAgent(machine, { executors, verification: false });
    const mixed = await runDurableAgent(machine, {
      entries: unhashed.entries,
      event: { type: "REJECT" },
      executors,
    });
    expect(mixed.status).toBe("idle");
    const hashedIndex = mixed.entries.findIndex((entry) => entry.verification !== undefined);
    expect(hashedIndex).toBeGreaterThan(0);

    // The mixed journal itself resumes fine.
    await expect(
      runDurableAgent(machine, {
        entries: mixed.entries,
        event: { type: "APPROVE" },
        executors,
      }),
    ).resolves.toMatchObject({ status: "done" });

    // Tamper with the last HASHED entry (a completion the second leg recorded).
    const tamperIndex = mixed.entries.length - 1;
    expect(mixed.entries[tamperIndex]!.verification).toBeDefined();
    const tampered = mixed.entries.map((entry, index) =>
      index === tamperIndex
        ? { ...entry, event: { ...entry.event, output: "a different draft" } }
        : entry,
    );

    await expect(
      runDurableAgent(machine, {
        entries: tampered,
        event: { type: "APPROVE" },
        executors,
      }),
    ).rejects.toMatchObject({
      name: "AgentReplayDivergenceError",
      // The divergence is a real hash mismatch, not the "no hashes here"
      // rejection strict mode raises for the unhashed prefix.
      index: tamperIndex,
      kind: "state",
    });
  });
});
