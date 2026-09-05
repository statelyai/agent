import { describe, expect, test } from "vitest";
import {
  createAsyncLogic,
  setup,
  transition,
  type AnyMachineSnapshot,
  type EventObject,
} from "xstate";
import {
  AGENT_EVENT_SCHEMA_VERSION,
  AGENT_INIT_EVENT_TYPE,
  AgentEventLogError,
  AgentMachineVersionMismatchError,
  AgentReplayDivergenceError,
  NonSerializableAgentEventError,
  agentCallOccurrence,
  assertAgentLogEntry,
  createReplayEntry,
  forkEventLog,
  getLogExecutionId,
  getSnapshotStateHash,
  getUsageFromEvents,
  initEntry,
  rebindActorSession,
  replay,
  validateReplayEntries,
  type AgentLogEntry,
} from "./event-log.js";
import { AGENT_USAGE_EVENT_TYPE } from "./usage.js";

// A machine with one invoked async actor. The actor throws if it is ever run,
// so any test that reaches `done` proves replay never executed it.
function createJobMachine() {
  const job = createAsyncLogic<string, { attempt: number }>({
    run: () => {
      throw new Error("the invoked actor must never run during replay");
    },
  });
  return setup({ actors: { job } }).createMachine({
    id: "jobber",
    initial: "idle",
    context: ({ input }: { input?: { attempt?: number } }) => ({
      attempt: input?.attempt ?? 0,
      result: null as string | null,
    }),
    states: {
      idle: { on: { GO: { target: "working" } } },
      working: {
        invoke: {
          id: "job",
          src: "job",
          input: ({ context }) => ({ attempt: context.attempt }),
          onDone: ({ output }: { output: string }) => ({
            target: "done",
            context: { result: output },
          }),
          onError: { target: "failed" },
        },
      },
      done: { type: "final" },
      failed: {},
    },
  });
}

/** Journaled events carry actor identity fields that `EventObject` does not declare. */
function journaled(event: Record<string, unknown> & { type: string }): EventObject {
  return event as EventObject;
}

const machine = createJobMachine();

/** Builds the log of a run that goes idle → working → done, by hand. */
function buildLog(options: { output?: string; error?: unknown } = {}): AgentLogEntry[] {
  const entries: AgentLogEntry[] = [
    initEntry(machine, { input: { attempt: 1 } }, { metadata: { executionId: "exec_1" } }),
  ];
  entries.push(createReplayEntry(machine, entries, { type: "GO" }));
  // The invoke's session id at this point in the fold; `rebindActorSession`
  // re-derives it on replay, so any plausible value round-trips.
  const { snapshot } = replay(machine, entries);
  const sessionId = (
    Object.values((snapshot as AnyMachineSnapshot).children)[0] as {
      sessionId: string;
    }
  ).sessionId;
  entries.push(
    createReplayEntry(
      machine,
      entries,
      "error" in options
        ? journaled({ type: "xstate.error.actor", actorId: "job", sessionId, error: options.error })
        : journaled({
            type: "xstate.done.actor",
            actorId: "job",
            sessionId,
            output: options.output ?? "shipped",
          }),
    ),
  );
  return entries;
}

describe("entry creation", () => {
  test("initEntry carries input, index 0, and a recorded state hash", () => {
    const entry = initEntry(machine, { input: { attempt: 2 } }, { metadata: { executionId: "e" } });

    expect(entry.schemaVersion).toBe(AGENT_EVENT_SCHEMA_VERSION);
    expect(entry.id).toBe("evt_00000000");
    expect(entry.index).toBe(0);
    expect(entry.event.type).toBe(AGENT_INIT_EVENT_TYPE);
    expect((entry.event as unknown as { input: unknown }).input).toEqual({ attempt: 2 });
    expect(entry.machineId).toBe("jobber");
    expect(entry.verification?.stateHash).toMatch(/^[0-9a-f]{8}$/);
    expect(() => assertAgentLogEntry(entry)).not.toThrow();
  });

  test("initEntry rejects both input and snapshot", () => {
    const { persistedSnapshot } = replay(machine, [initEntry(machine, { input: undefined })]);

    expect(() =>
      initEntry(machine, { input: 1, snapshot: persistedSnapshot } as never),
    ).toThrowError(AgentEventLogError);
  });

  test("createReplayEntry indexes from the prefix and honors id/recordedAt/causationId", () => {
    const entries = [initEntry(machine, { input: undefined })];
    const entry = createReplayEntry(
      machine,
      entries,
      { type: "GO" },
      {
        id: "custom",
        recordedAt: "2026-01-01T00:00:00.000Z",
        causationId: entries[0]!.id,
        metadata: { note: "manual" },
      },
    );

    expect(entry.index).toBe(1);
    expect(entry.id).toBe("custom");
    expect(entry.recordedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(entry.causationId).toBe("evt_00000000");
    expect(entry.metadata).toEqual({ note: "manual" });
  });

  test("verification: false omits the hash", () => {
    const entry = initEntry(machine, { input: undefined }, { verification: false });

    expect(entry.verification).toBeUndefined();
  });

  test("an explicit snapshot option matches the folded hash", () => {
    const entries = [initEntry(machine, { input: undefined })];
    const { snapshot } = replay(machine, entries);
    const [next] = transition(machine, snapshot, { type: "GO" } as never);

    const withSnapshot = createReplayEntry(machine, entries, { type: "GO" }, { snapshot: next });
    const folded = createReplayEntry(machine, entries, { type: "GO" });

    expect(withSnapshot.verification).toEqual(folded.verification);
  });

  test("Error payloads are normalized into plain objects", () => {
    const entries = [initEntry(machine, { input: undefined })];
    const entry = createReplayEntry(
      machine,
      entries,
      journaled({ type: "xstate.error.actor", actorId: "job", error: new TypeError("boom") }),
      { verification: false },
    );

    expect((entry.event as unknown as { error: unknown }).error).toEqual({
      name: "TypeError",
      message: "boom",
    });
  });

  test("non-serializable payloads are rejected with the offending path", () => {
    const entries = [initEntry(machine, { input: undefined })];

    let caught: unknown;
    try {
      createReplayEntry(machine, entries, { type: "GO", fn: () => 1 } as never);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(NonSerializableAgentEventError);
    expect((caught as NonSerializableAgentEventError).path).toBe("entry.event.fn");
    expect((caught as NonSerializableAgentEventError).code).toBe("non-serializable-event");
  });

  test("a log round-trips through JSON unchanged, metadata included", () => {
    const entries = buildLog();
    const roundTripped = JSON.parse(JSON.stringify(entries)) as AgentLogEntry[];

    expect(roundTripped).toEqual(entries);
    expect(getLogExecutionId(roundTripped)).toBe("exec_1");
  });
});

describe("validateReplayEntries", () => {
  test("accepts a well-formed log", () => {
    expect(() => validateReplayEntries(buildLog(), { machine })).not.toThrow();
  });

  test("rejects a log that does not start with the init entry", () => {
    const entries = buildLog()
      .slice(1)
      .map((entry, index) => ({ ...entry, index }));

    expect(() => validateReplayEntries(entries)).toThrowError(AgentEventLogError);
  });

  test("rejects non-contiguous indices", () => {
    const entries = buildLog();
    entries[2] = { ...entries[2]!, index: 5 };

    expect(() => validateReplayEntries(entries)).toThrowError(/contiguous/);
  });

  test("rejects duplicate entry ids", () => {
    const entries = buildLog();
    entries[2] = { ...entries[2]!, id: entries[1]!.id };

    expect(() => validateReplayEntries(entries)).toThrowError(/duplicate entry id/);
  });

  test("rejects a bad schemaVersion", () => {
    const entries = buildLog();
    entries[1] = { ...entries[1]!, schemaVersion: 2 as never };

    expect(() => validateReplayEntries(entries)).toThrowError(/schema version/);
  });
});

describe("replay", () => {
  test("folds a journaled invoke completion without running the actor", () => {
    const entries = buildLog({ output: "shipped" });

    const { snapshot, persistedSnapshot } = replay(machine, entries);

    expect(snapshot.value).toBe("done");
    expect(snapshot.context.result).toBe("shipped");
    expect((persistedSnapshot as unknown as { value: unknown }).value).toBe("done");
  });

  test("rebinds actor sessions across a JSON round-trip", () => {
    const entries = JSON.parse(JSON.stringify(buildLog())) as AgentLogEntry[];
    // A stale session id from another process: without rebinding, XState drops
    // the completion and the machine never leaves `working`.
    entries[2] = {
      ...entries[2]!,
      event: journaled({ ...entries[2]!.event, sessionId: "stale:from:another:run" }),
    };

    const { snapshot } = replay(machine, entries, { verify: false });

    expect(snapshot.value).toBe("done");
  });

  test("rebindActorSession leaves non-actor events alone", () => {
    const event = { type: "GO" };

    expect(rebindActorSession(event, {} as AnyMachineSnapshot, new Map())).toBe(event);
  });

  test("a journaled error completion replays to the error branch", () => {
    const { snapshot } = replay(machine, buildLog({ error: new Error("nope") }));

    expect(snapshot.value).toBe("failed");
  });

  test("verify: true accepts an untampered log and rejects a tampered hash", () => {
    const entries = buildLog();

    expect(() => replay(machine, entries, { verify: true })).not.toThrow();

    entries[2] = { ...entries[2]!, verification: { stateHash: "deadbeef" } };
    let caught: unknown;
    try {
      replay(machine, entries, { verify: true });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AgentReplayDivergenceError);
    expect((caught as AgentReplayDivergenceError).kind).toBe("state");
    expect((caught as AgentReplayDivergenceError).index).toBe(2);
    expect((caught as AgentReplayDivergenceError).expected).toBe("deadbeef");
    expect((caught as AgentReplayDivergenceError).code).toBe("replay-diverged");
  });

  test("verify: 'strict' requires a hash on every entry; verify: false skips both", () => {
    const entries = buildLog();
    const withoutHash = { ...entries[1]! };
    delete withoutHash.verification;
    entries[1] = withoutHash;

    expect(() => replay(machine, entries, { verify: true })).not.toThrow();
    expect(() => replay(machine, entries, { verify: false })).not.toThrow();

    let caught: unknown;
    try {
      replay(machine, entries, { verify: "strict" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AgentReplayDivergenceError);
    expect((caught as AgentReplayDivergenceError).kind).toBe("missing-verification");
  });

  test("a machine version mismatch throws", () => {
    const entries = buildLog();
    entries[1] = { ...entries[1]!, machineVersion: "some-other-version" };

    let caught: unknown;
    try {
      replay(machine, entries);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AgentMachineVersionMismatchError);
    expect((caught as AgentMachineVersionMismatchError).code).toBe("machine-version-mismatch");
    expect((caught as AgentMachineVersionMismatchError).index).toBe(1);
  });

  test("an init-with-snapshot entry bridges an older version and replays onward", () => {
    // The persisted snapshot of a run paused mid-invoke, as a host would store it.
    const previous = buildLog().slice(0, 2);
    const { persistedSnapshot } = replay(machine, previous);
    const bridged = JSON.parse(JSON.stringify(persistedSnapshot)) as typeof persistedSnapshot;

    const entries: AgentLogEntry[] = [
      initEntry(machine, { snapshot: bridged }, { machineVersion: "v0-legacy" }),
    ];
    entries.push(
      createReplayEntry(
        machine,
        entries,
        journaled({
          type: "xstate.done.actor",
          actorId: "job",
          sessionId: "recorded:elsewhere",
          output: "bridged",
        }),
      ),
    );

    const { snapshot } = replay(machine, entries);

    expect(snapshot.value).toBe("done");
    expect(snapshot.context.result).toBe("bridged");
  });

  test("an empty log cannot be replayed", () => {
    expect(() => replay(machine, [])).toThrowError(AgentEventLogError);
  });
});

describe("getSnapshotStateHash", () => {
  test("is stable across a JSON round-trip and changes with state", () => {
    const early = replay(machine, buildLog().slice(0, 2)).persistedSnapshot;
    const late = replay(machine, buildLog()).persistedSnapshot;

    expect(getSnapshotStateHash(early)).toBe(
      getSnapshotStateHash(JSON.parse(JSON.stringify(early))),
    );
    expect(getSnapshotStateHash(early)).not.toBe(getSnapshotStateHash(late));
  });
});

describe("agentCallOccurrence", () => {
  test("counts done and error completions for the site, 1-based", () => {
    const history = [
      journaled({ type: "GO" }),
      journaled({ type: "xstate.done.actor", actorId: "job", output: 1 }),
      journaled({ type: "xstate.error.actor", actorId: "job", error: "x" }),
      journaled({ type: "xstate.done.actor", actorId: "other", output: 2 }),
    ];

    expect(agentCallOccurrence(history, "job")).toBe(3);
    expect(agentCallOccurrence(history, "other")).toBe(2);
    expect(agentCallOccurrence(history, "unknown")).toBe(1);
    expect(agentCallOccurrence(undefined, "job")).toBe(1);
  });

  test("accepts log entries as well as bare events", () => {
    expect(agentCallOccurrence(buildLog(), "job")).toBe(2);
  });
});

describe("getUsageFromEvents", () => {
  test("sums reported token fields and ignores non-finite values", () => {
    const usage = getUsageFromEvents([
      journaled({ type: AGENT_USAGE_EVENT_TYPE, usage: { inputTokens: 10, outputTokens: 4 } }),
      journaled({
        type: AGENT_USAGE_EVENT_TYPE,
        usage: { inputTokens: 5, outputTokens: Number.NaN },
      }),
      journaled({ type: "GO" }),
      journaled({ type: AGENT_USAGE_EVENT_TYPE }),
    ]);

    expect(usage.inputTokens).toBe(15);
    expect(usage.outputTokens).toBe(4);
    expect(usage.totalTokens).toBeUndefined();
  });
});

describe("forkEventLog", () => {
  test("slices an exclusive prefix that still replays", () => {
    const entries = buildLog();

    const forked = forkEventLog(entries, 2);

    expect(forked).toHaveLength(2);
    expect(forked[1]).toEqual(entries[1]);
    expect(replay(machine, forked).snapshot.value).toBe("working");
  });

  test("rejects a cutoff that drops the init entry or overruns the log", () => {
    const entries = buildLog();

    expect(() => forkEventLog(entries, 0)).toThrowError(AgentEventLogError);
    expect(() => forkEventLog(entries, 99)).toThrowError(AgentEventLogError);
  });
});
