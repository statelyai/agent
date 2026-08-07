import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  AgentDecisionExhaustedError,
  AgentError,
  AgentEventLogConflictError,
  AgentIdleError,
  AgentIllegalResumeEventError,
  AgentLintError,
  AgentReplayDivergenceError,
  AgentReplayMachineMismatchError,
  AgentSnapshotVersionMismatchError,
  createAgentSchemas,
  createTextLogic,
  NonSerializableAgentEventError,
  runAgent,
  serializeTraceEvent,
  setupAgent,
  type AgentTraceEvent,
  type JsonSerializableTraceEvent,
  type JsonValue,
  type RunAgentErrorCause,
} from "./index.js";

// ─── Compile-time pin: the derived JsonSerializableTraceEvent must stay
// structurally identical to the hand-written union it replaced. Edit this
// baseline ONLY together with a deliberate AgentTraceEvent shape change.
type HandWrittenJsonSerializableTraceEvent = {
  schemaVersion: 1;
  runId: string;
  seq: number;
  timestamp: string;
  machineId: string;
  machineVersion: string;
} & (
  | { type: "run.start"; input?: JsonValue; snapshot?: JsonValue; event?: JsonValue }
  | { type: "request.start"; request: JsonValue }
  | {
      type: "request.end";
      request: JsonValue;
      output: JsonValue;
      raw?: JsonValue;
      reasoning?: string;
      usage?: JsonValue;
    }
  | { type: "request.error"; request: JsonValue; error: JsonValue }
  | { type: "stream.chunk"; request: JsonValue; chunk: string }
  | { type: "machine.transition"; snapshot: JsonValue; event: JsonValue; eventId?: string }
  | { type: "emit"; event: JsonValue }
  | { type: "usage.dropped"; event: JsonValue; reason: "settled" }
  | { type: "run.end"; status: "done"; output: JsonValue; snapshot: JsonValue }
  | {
      type: "run.end";
      status: "idle";
      snapshot: JsonValue;
      pendingUserInputs?: JsonValue;
      persistedSnapshot?: JsonValue;
    }
  | {
      type: "run.end";
      status: "error";
      cause: RunAgentErrorCause;
      error: JsonValue;
      snapshot: JsonValue;
    }
);

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// Both `true` assignments fail to compile if the derived type drifts.
const _derivedMatchesHandWritten: MutuallyAssignable<
  JsonSerializableTraceEvent,
  HandWrittenJsonSerializableTraceEvent
> = true;
void _derivedMatchesHandWritten;

// Envelope fields every serialized event keeps verbatim.
const envelope = {
  schemaVersion: 1,
  runId: "run_1",
  seq: 1,
  timestamp: "2026-01-01T00:00:00.000Z",
  machineId: "test",
  machineVersion: "v1",
} as const;

function roundTrip(event: ReturnType<typeof serializeTraceEvent>) {
  return JSON.parse(JSON.stringify(event));
}

describe("serializeTraceEvent", () => {
  test("serializes every trace event type and survives a JSON round-trip", () => {
    const events: AgentTraceEvent[] = [
      { ...envelope, type: "run.start", input: { topic: "rivers" } },
      {
        ...envelope,
        type: "request.start",
        request: { kind: "text", id: "req_1", model: "test-model" } as never,
      },
      {
        ...envelope,
        type: "request.end",
        request: { kind: "text", id: "req_1", model: "test-model" } as never,
        output: { answer: "42" },
        raw: { provider: "test" },
        reasoning: "because",
      },
      {
        ...envelope,
        type: "request.error",
        request: { kind: "text", id: "req_1", model: "test-model" } as never,
        error: new Error("boom"),
      },
      {
        ...envelope,
        type: "stream.chunk",
        request: { kind: "text", id: "req_1", model: "test-model" } as never,
        chunk: "hello",
      },
      {
        ...envelope,
        type: "machine.transition",
        snapshot: { value: "a", context: {} } as never,
        event: { type: "GO" },
        eventId: "evt_00000001",
      },
      { ...envelope, type: "emit", event: { type: "DRAFTED" } as never },
      {
        ...envelope,
        type: "run.end",
        status: "done",
        output: { answer: "42" } as never,
        snapshot: { value: "done", context: {} } as never,
      },
      {
        ...envelope,
        type: "run.end",
        status: "idle",
        snapshot: { value: "waiting", context: {} } as never,
        persistedSnapshot: { value: "waiting" } as never,
      },
      {
        ...envelope,
        type: "run.end",
        status: "error",
        cause: "machine",
        error: new AgentIdleError({ value: "waiting" } as never, ["GO"]),
        snapshot: { value: "waiting", context: {} } as never,
      },
    ];

    for (const event of events) {
      const serialized = serializeTraceEvent(event);
      expect(serialized.type).toBe(event.type);
      expect(serialized.schemaVersion).toBe(1);
      expect(roundTrip(serialized)).toEqual(serialized);
    }
  });

  test("passes a request.end `usage` through as plain JSON", () => {
    const event: AgentTraceEvent = {
      ...envelope,
      type: "request.end",
      request: { kind: "text", id: "req_1" } as never,
      output: "ok",
      raw: { provider: "test" },
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
    };

    const serialized = serializeTraceEvent(event);
    expect(serialized).toHaveProperty("usage", {
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
    });
    expect(roundTrip(serialized)).toEqual(serialized);
  });

  test("drops `raw` unless includeRaw is set", () => {
    const event: AgentTraceEvent = {
      ...envelope,
      type: "request.end",
      request: { kind: "text", id: "req_1" } as never,
      output: "ok",
      raw: { provider: "test", nested: { ok: true } },
    };

    expect(serializeTraceEvent(event)).not.toHaveProperty("raw");
    expect(serializeTraceEvent(event, { includeRaw: true })).toHaveProperty("raw", {
      provider: "test",
      nested: { ok: true },
    });
  });

  test("drops functions, undefined, symbols and cycles instead of throwing", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;

    const snapshot = {
      value: "a",
      context: {
        keep: "yes",
        fn: () => "nope",
        gone: undefined,
        sym: Symbol("nope"),
        when: new Date("2026-01-01T00:00:00.000Z"),
        big: 10n,
        nan: Number.NaN,
        list: [1, () => 2, "three"],
        cyclic,
      },
    };

    const serialized = serializeTraceEvent({
      ...envelope,
      type: "machine.transition",
      snapshot: snapshot as never,
      event: { type: "GO" },
    });

    expect(() => JSON.stringify(serialized)).not.toThrow();
    // Drop semantics: non-JSON values vanish, array holes become null,
    // Date goes through toJSON, bigint stringifies, NaN becomes null.
    expect(serialized).toMatchObject({
      type: "machine.transition",
      snapshot: {
        value: "a",
        context: {
          keep: "yes",
          when: "2026-01-01T00:00:00.000Z",
          big: "10",
          nan: null,
          list: [1, null, "three"],
          cyclic: { name: "loop" },
        },
      },
    });
    const context = (serialized as unknown as { snapshot: { context: Record<string, unknown> } })
      .snapshot.context;
    expect(context).not.toHaveProperty("fn");
    expect(context).not.toHaveProperty("gone");
    expect(context).not.toHaveProperty("sym");
    expect(context.cyclic).not.toHaveProperty("self");
    expect(roundTrip(serialized)).toEqual(serialized);
  });

  test("serializes errors as { name, message, stack, code } instead of {}", () => {
    const serialized = serializeTraceEvent({
      ...envelope,
      type: "run.end",
      status: "error",
      cause: "machine",
      error: new AgentIllegalResumeEventError("GO", ["STOP"]),
      snapshot: { value: "a" } as never,
    });

    expect(serialized).toMatchObject({
      status: "error",
      cause: "machine",
      error: {
        name: "AgentIllegalResumeEventError",
        code: "illegal-resume-event",
        message: expect.stringContaining("cannot resume"),
      },
    });
  });

  test("serializes a real runAgent trace stream to JSONL", async () => {
    const schemas = createAgentSchemas({
      context: z.object({ draft: z.string().nullable() }),
      output: z.object({ draft: z.string() }),
    });
    const agent = setupAgent({
      schemas,
      actors: {
        draft: createTextLogic({ model: "test-model", prompt: () => "draft it" }),
      },
    });
    const machine = agent.createMachine({
      context: { draft: null },
      initial: "drafting",
      states: {
        drafting: {
          invoke: {
            src: "draft",
            onDone: ({ output }) => ({ target: "done", context: { draft: output } }),
          },
        },
        done: { type: "final", output: ({ context }) => ({ draft: context.draft ?? "" }) },
      },
    });

    const trace: AgentTraceEvent<typeof machine>[] = [];
    const result = await runAgent(machine, {
      onTrace: (event) => trace.push(event),
      executors: { generateText: async () => ({ output: "a draft", raw: { provider: {} } }) },
    });

    expect(result.status).toBe("done");
    const jsonl = trace
      .map((event) => JSON.stringify(serializeTraceEvent(event as AgentTraceEvent)))
      .join("\n");
    const parsed = jsonl.split("\n").map((line) => JSON.parse(line));
    expect(parsed.map((event) => event.type)).toEqual(trace.map((event) => event.type));
    expect(parsed.every((event) => event.schemaVersion === 1)).toBe(true);
    expect(parsed.find((event) => event.type === "request.end")).not.toHaveProperty("raw");
  });
});

describe("AgentError", () => {
  test("every error extends AgentError and carries a stable kebab-case code", () => {
    const errors: Array<[AgentError, string]> = [
      [new AgentIdleError({ value: "a" } as never, ["GO"]), "agent-idle"],
      [new AgentIllegalResumeEventError("GO", ["STOP"]), "illegal-resume-event"],
      [new AgentSnapshotVersionMismatchError("v1", "v2", "m"), "snapshot-version-mismatch"],
      [new AgentDecisionExhaustedError([]), "decision-exhausted"],
      [new AgentLintError("m", []), "lint-failed"],
      [new AgentEventLogConflictError("t", 1, 2), "event-log-conflict"],
      [new NonSerializableAgentEventError("event.x", "function"), "non-serializable-event"],
      [
        new AgentReplayMachineMismatchError(
          "evt_1",
          0,
          { machineId: "a", machineVersion: "1" },
          { machineId: "b", machineVersion: "2" },
        ),
        "replay-machine-mismatch",
      ],
      [new AgentReplayDivergenceError("evt_1", 0, "state"), "replay-divergence"],
    ];

    for (const [error, code] of errors) {
      expect(error).toBeInstanceOf(AgentError);
      expect(error).toBeInstanceOf(Error);
      expect(error.code).toBe(code);
      expect(error.name).toMatch(/Error$/);
      expect(code).toMatch(/^[a-z]+(-[a-z]+)*$/);
    }
  });
});
