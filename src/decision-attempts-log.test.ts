import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createActor, createMachine } from "xstate";
import { decideNext } from "./decide-next.js";
import {
  createDecisionLogic,
  type AgentDecisionExecutor,
  type AgentDecisionRequest,
  type DecisionAttempt,
} from "./decision.js";
import { AGENT_EVENT_SCHEMA_VERSION, getSnapshotStateHash } from "./event-log.js";
import {
  AgentEventLogError,
  assertAgentLogEntry,
  createInMemoryEventLogStore,
  getDecisionAttempts,
  replay,
  type AgentLogEntry,
} from "./log/index.js";
import { createAgentRuntime, runAgent } from "./run-agent.js";
import { setupAgent } from "./setup-agent.js";
import type { ChosenEvent } from "./types.js";

// HEAL is type- and payload-legal but guard-rejected at hp 10; ATTACK lands.
function guardedMoveMachine(withOnError = true) {
  const schemas = {
    context: z.object({ hp: z.number() }),
    input: z.object({}),
    events: { ATTACK: z.object({ target: z.string() }), HEAL: z.object({}) },
  };
  const chooseMove = createDecisionLogic({
    model: "test-model",
    prompt: "Choose a move.",
    allowedEvents: ["ATTACK", "HEAL"] as const,
  });
  return setupAgent({ ...schemas, actors: { chooseMove } }).createMachine({
    id: "moves",
    context: { hp: 10 },
    initial: "choosing",
    states: {
      choosing: {
        invoke: {
          id: "choosing",
          src: "chooseMove",
          input: {},
          ...(withOnError ? { onError: { target: "fumbled" } } : {}),
        },
        on: {
          HEAL: ({ context }) => (context.hp < 5 ? { target: "healed" } : undefined),
          ATTACK: { target: "attacked" },
        },
      },
      attacked: { type: "final" },
      healed: { type: "final" },
      fumbled: { type: "final" },
    },
  });
}

const healThenAttack = (): AgentDecisionExecutor => {
  let calls = 0;
  return async () =>
    ++calls === 1 ? { event: { type: "HEAL" } } : { event: { type: "ATTACK", target: "goblin" } };
};

const alwaysUnknown = async (): Promise<{ event: ChosenEvent }> => ({
  event: { type: "BOGUS" },
});

// A log as an older writer produced it: no entry `attempts`, no exhausted `attempts`.
function stripDecisionData(entries: readonly AgentLogEntry[]): AgentLogEntry[] {
  return entries.map((entry) => {
    const { attempts: _attempts, ...rest } = structuredClone(entry);
    const error = (rest.event as { error?: { attempts?: unknown } }).error;
    if (error && typeof error === "object") delete error.attempts;
    return rest as AgentLogEntry;
  });
}

const finalHash = (machine: Parameters<typeof replay>[0], entries: readonly AgentLogEntry[]) =>
  getSnapshotStateHash(replay(machine, entries, { verify: "strict" }).persistedSnapshot);

describe("decision attempts in the event log", () => {
  test("a guard-rejected first attempt is journaled on the delivered event's entry", async () => {
    const machine = guardedMoveMachine();
    const store = createInMemoryEventLogStore();
    const result = await runAgent(machine, {
      store,
      threadId: "moves-1",
      executors: { decide: healThenAttack() },
      input: {},
    });

    expect(result.status).toBe("done");
    const attack = result.events.find((entry) => entry.event.type === "ATTACK")!;
    expect(attack.attempts).toEqual([
      {
        event: { type: "HEAL" },
        failure: "rejected-by-guard",
        reason: "'HEAL' is not currently takeable (guard rejected it).",
      },
    ]);
    // Only the entry the attempts explain carries them.
    expect(result.events.filter((entry) => entry.attempts !== undefined)).toHaveLength(1);
    // The store round-trips the field verbatim.
    const stored = await store.read("moves-1");
    expect(stored.find((entry) => entry.event.type === "ATTACK")!.attempts).toEqual(
      attack.attempts,
    );
  });

  test("a first-try decision journals no attempts field", async () => {
    const result = await runAgent(guardedMoveMachine(), {
      executors: { decide: async () => ({ event: { type: "ATTACK", target: "orc" } }) },
      input: {},
    });
    expect(result.events.some((entry) => entry.attempts !== undefined)).toBe(false);
  });

  test("replay ignores decision attempts: the same state hash with the field stripped", async () => {
    const machine = guardedMoveMachine();
    const result = await runAgent(machine, { executors: { decide: healThenAttack() }, input: {} });

    const tail = result.events[result.events.length - 1]!;
    expect(finalHash(machine, result.events)).toBe(tail.verification!.stateHash);
    expect(finalHash(machine, stripDecisionData(result.events))).toBe(
      finalHash(machine, result.events),
    );
  });

  test("an exhausted decision's xstate.error.actor entry keeps its attempts", async () => {
    const machine = guardedMoveMachine();
    const result = await runAgent(machine, { executors: { decide: alwaysUnknown }, input: {} });

    expect(result.snapshot.value).toBe("fumbled");
    const failed = result.events.find((entry) =>
      entry.event.type.startsWith("xstate.error.actor"),
    )!;
    const error = (failed.event as unknown as { error: { name: string; attempts: unknown[] } })
      .error;
    expect(error.name).toBe("AgentDecisionExhaustedError");
    expect(error.attempts).toHaveLength(3);
    expect(error.attempts[0]).toMatchObject({ event: { type: "BOGUS" }, failure: "unknown-event" });
    // Strict JSON, and still replays with every hash verified.
    expect(JSON.parse(JSON.stringify(failed))).toEqual(failed);
    expect(() => replay(machine, result.events, { verify: "strict" })).not.toThrow();
  });

  test("an old-format log (no entry attempts, error without attempts) still replays to the same state", async () => {
    const machine = guardedMoveMachine();
    for (const decide of [healThenAttack(), alwaysUnknown]) {
      const result = await runAgent(machine, { executors: { decide }, input: {} });
      const old = stripDecisionData(result.events);
      expect(old.every((entry) => entry.schemaVersion === AGENT_EVENT_SCHEMA_VERSION)).toBe(true);
      expect(finalHash(machine, old)).toBe(finalHash(machine, result.events));
    }
  });

  test("getDecisionAttempts lists delivered-entry attempts and exhausted errors in log order", async () => {
    const machine = guardedMoveMachine();
    const landed = await runAgent(machine, { executors: { decide: healThenAttack() }, input: {} });
    const exhausted = await runAgent(machine, { executors: { decide: alwaysUnknown }, input: {} });

    const fromLanded = getDecisionAttempts(landed.events);
    expect(fromLanded).toEqual([
      {
        index: landed.events.findIndex((entry) => entry.event.type === "ATTACK"),
        eventType: "ATTACK",
        attempts: [expect.objectContaining({ failure: "rejected-by-guard" })],
      },
    ]);

    const fromExhausted = getDecisionAttempts(exhausted.events);
    expect(fromExhausted).toHaveLength(1);
    expect(fromExhausted[0]!.eventType).toMatch(/^xstate\.error\.actor/);
    expect(fromExhausted[0]!.attempts.map((attempt) => attempt.failure)).toEqual([
      "unknown-event",
      "unknown-event",
      "unknown-event",
    ]);

    expect(getDecisionAttempts(stripDecisionData(landed.events))).toEqual([]);
  });

  test("assertAgentLogEntry rejects a malformed attempts field", () => {
    const base: AgentLogEntry = {
      schemaVersion: AGENT_EVENT_SCHEMA_VERSION,
      id: "evt_1",
      index: 1,
      recordedAt: "2026-01-01T00:00:00.000Z",
      machineId: "m",
      machineVersion: "v1",
      event: { type: "GO" },
    };
    expect(() =>
      assertAgentLogEntry({
        ...base,
        attempts: [{ failure: "unknown-event", reason: "nope" }],
      }),
    ).not.toThrow();
    expect(() => assertAgentLogEntry({ ...base, attempts: "nope" as never })).toThrow(
      AgentEventLogError,
    );
    expect(() => assertAgentLogEntry({ ...base, attempts: [{}] as never })).toThrow(
      AgentEventLogError,
    );
  });
});

// A plain XState machine, decided at the boundary by `decideNext`.
const desk = createMachine({
  id: "desk",
  schemas: {
    context: z.object({ limit: z.number(), refunded: z.number() }),
    events: { "desk.refund": z.object({ amount: z.number() }), "desk.escalate": z.object({}) },
  },
  context: { limit: 50, refunded: 0 },
  initial: "reviewing",
  states: {
    reviewing: {
      on: {
        "desk.refund": {
          to: ({ context, event }) =>
            event.amount <= context.limit
              ? { target: "refunded", context: { ...context, refunded: event.amount } }
              : undefined,
        },
        "desk.escalate": { target: "escalated" },
      },
    },
    refunded: { type: "final" },
    escalated: { type: "final" },
  },
});

describe("boundary decisions (decideNext) journaled by the host", () => {
  test("runAgent({ event, attempts }) records decideNext's attempts on the event's entry", async () => {
    const store = createInMemoryEventLogStore();
    const threadId = "desk-1";
    const opened = await runAgent(desk, { store, threadId });
    expect(opened.status).toBe("idle");

    // First try: a refund the desk never offered; second try: the offered one.
    const requests: AgentDecisionRequest[] = [];
    const decide: AgentDecisionExecutor = async (request) => {
      requests.push(request);
      return requests.length === 1
        ? { event: { type: "desk.refund", amount: 999 } }
        : { event: request.options![0]!.event };
    };
    const { event, attempts } = await decideNext(createActor(desk).start().getSnapshot(), {
      decide,
      model: "quick",
      allowedEvents: "desk.*",
      payloads: () => ({ "desk.refund": [{ amount: 20 }] }),
    });
    expect(attempts).toHaveLength(1);

    const result = await runAgent(desk, { store, threadId, event: event!, attempts });

    expect(result.status).toBe("done");
    const stored = await store.read(threadId);
    const refund = stored[stored.length - 1]!;
    expect(refund.event).toEqual({ type: "desk.refund", amount: 20 });
    expect(refund.attempts).toEqual(attempts);
    expect(getDecisionAttempts(stored)).toEqual([
      { index: refund.index, eventType: "desk.refund", attempts },
    ]);
    expect(finalHash(desk, stripDecisionData(stored))).toBe(finalHash(desk, stored));
  });

  test("an empty attempts list journals no attempts field", async () => {
    const result = await runAgent(desk, { event: { type: "desk.escalate" }, attempts: [] });
    expect(result.events.some((entry) => "attempts" in entry)).toBe(false);
  });

  test("runtime.transition rejects non-JSON attempts before the machine moves", async () => {
    const runtime = createAgentRuntime(desk);
    const [state] = await runtime.start({});
    expect(() =>
      runtime.transition(
        state,
        { type: "desk.escalate" },
        {
          attempts: [
            { failure: "unknown-event", reason: "x", event: { type: "X", at: new Date() } },
          ],
        },
      ),
    ).toThrow(/not JSON-serializable/);
    const result = await runtime.finish();
    expect(result.snapshot.value).toBe("reviewing");
    expect(result.events).toHaveLength(1);
  });

  test("runtime.transition copies attempts: mutating the caller's array leaves the entry", async () => {
    const runtime = createAgentRuntime(desk);
    const [state] = await runtime.start({});
    const attempts: DecisionAttempt[] = [
      {
        failure: "unknown-event",
        reason: "not offered",
        event: { type: "desk.refund", amount: 999 },
      },
    ];
    runtime.transition(state, { type: "desk.escalate" }, { attempts });
    attempts.push({ failure: "unknown-event", reason: "added later", event: { type: "X" } });
    attempts[0]!.reason = "rewritten";
    (attempts[0]!.event as unknown as { amount: number }).amount = 1;

    const result = await runtime.finish();
    expect(result.events[result.events.length - 1]!.attempts).toEqual([
      {
        failure: "unknown-event",
        reason: "not offered",
        event: { type: "desk.refund", amount: 999 },
      },
    ]);
  });

  test("getDecisionAttempts ignores an unrelated actor error that carries attempts", () => {
    const entries = [
      {
        schemaVersion: AGENT_EVENT_SCHEMA_VERSION,
        id: "evt_00000001",
        index: 1,
        recordedAt: "2026-01-01T00:00:00.000Z",
        machineId: "desk",
        machineVersion: "1",
        event: {
          type: "xstate.error.actor.upload",
          error: {
            name: "UploadError",
            message: "retry budget spent",
            attempts: [{ failure: "unknown-event", reason: "not a decision" }],
          },
        },
      },
    ] as unknown as AgentLogEntry[];
    expect(getDecisionAttempts(entries)).toEqual([]);
  });
});
