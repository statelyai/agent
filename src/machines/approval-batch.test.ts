import { describe, expect, test } from "vitest";
import { createAsyncLogic, type AnyStateMachine } from "xstate";
import { createAgentRuntime, getInteraction, runToQuiescence } from "../index.js";
import { canReach, explorePaths, lintAgentMachine } from "../testing/index.js";
import { isExplorationComplete } from "../verify.js";
import { createApprovalBatchMachine, type ApprovalDecision, type ProposedCall } from "./index.js";

const calls: ProposedCall[] = [
  { id: "c1", name: "read", args: { path: "a.txt" } },
  { id: "c2", name: "write", args: { path: "b.txt" } },
  { id: "c3", name: "rm", args: { path: "/" } },
];

const policyByName = createAsyncLogic<ApprovalDecision, { call: ProposedCall }>({
  run: async ({ input }) =>
    input.call.name === "read" ? "allow" : input.call.name === "rm" ? "deny" : "ask",
});

/** Records every executed call id, in order. */
function recordingExecute() {
  const executed: string[] = [];
  const execute = createAsyncLogic<string, { call: ProposedCall }>({
    run: async ({ input }) => {
      executed.push(input.call.id);
      return `ran ${input.call.name}`;
    },
  });
  return { execute, executed };
}

/** The per-call child machine, as registered on the batch. */
function callMachineOf(machine: AnyStateMachine): AnyStateMachine {
  return (machine as unknown as { sources: { actors: Record<string, AnyStateMachine> } }).sources
    .actors["call"]!;
}

describe("createApprovalBatchMachine", () => {
  test("lints clean, batch and per-call child", () => {
    const machine = createApprovalBatchMachine({ execute: recordingExecute().execute });
    const errors = (m: AnyStateMachine) =>
      lintAgentMachine(m).filter((diagnostic) => diagnostic.severity === "error");
    expect(errors(machine)).toEqual([]);
    expect(errors(callMachineOf(machine))).toEqual([]);
    expect(lintAgentMachine(callMachineOf(machine))).toEqual([]);
  });

  test("allReady: nothing executes until every approval settles", async () => {
    const { execute, executed } = recordingExecute();
    const machine = createApprovalBatchMachine({ policy: policyByName, execute });

    const paused = await runToQuiescence(createAgentRuntime(machine), { input: { calls } });
    expect(paused.status).toBe("idle");
    // `read` is allowed but held at the barrier while `write` waits on a person.
    expect(executed).toEqual([]);
    expect(paused.snapshot.context.awaiting.map((call) => call.id)).toEqual(["c2"]);
    expect(getInteraction(paused.snapshot)?.choices?.map((choice) => choice.event)).toEqual([
      { type: "APPROVE", callId: "c2" },
      { type: "APPROVE_ALWAYS", callId: "c2" },
      { type: "REJECT", callId: "c2" },
    ]);

    const result = await runToQuiescence(createAgentRuntime(machine), {
      snapshot: paused.persist(),
      event: { type: "APPROVE_ALWAYS", callId: "c2" },
    });
    expect(result.status).toBe("done");
    expect(executed.sort()).toEqual(["c1", "c2"]);
    expect(result.status === "done" && result.output).toEqual({
      results: [
        { id: "c1", status: "executed", result: "ran read" },
        { id: "c2", status: "executed", result: "ran write" },
        { id: "c3", status: "rejected", reason: "denied by policy" },
      ],
      approveAlways: [{ name: "write" }],
    });
  });

  test("call ids that name Object.prototype members are not read as settled", async () => {
    const { execute, executed } = recordingExecute();
    const machine = createApprovalBatchMachine({ policy: policyByName, execute });
    const odd: ProposedCall[] = [
      { id: "toString", name: "write", args: {} },
      { id: "constructor", name: "read", args: {} },
    ];
    const paused = await runToQuiescence(createAgentRuntime(machine), { input: { calls: odd } });
    expect(paused.status).toBe("idle");
    expect(paused.snapshot.context.awaiting.map((call) => call.id)).toEqual(["toString"]);
    const result = await runToQuiescence(createAgentRuntime(machine), {
      snapshot: paused.persist(),
      event: { type: "APPROVE", callId: "toString" },
    });
    expect(executed.sort()).toEqual(["constructor", "toString"]);
    expect(result.status === "done" && result.output.results).toEqual([
      { id: "toString", status: "executed", result: "ran write" },
      { id: "constructor", status: "executed", result: "ran read" },
    ]);
  });

  test("eachReady: an allowed call executes while another waits", async () => {
    const { execute, executed } = recordingExecute();
    const machine = createApprovalBatchMachine({
      policy: policyByName,
      execute,
      executeWhen: "eachReady",
    });

    const paused = await runToQuiescence(createAgentRuntime(machine), { input: { calls } });
    expect(paused.status).toBe("idle");
    expect(executed).toEqual(["c1"]);
    expect(paused.snapshot.context.results["c1"]?.status).toBe("executed");

    const result = await runToQuiescence(createAgentRuntime(machine), {
      snapshot: paused.persist(),
      event: { type: "REJECT", callId: "c2", reason: "not now" },
    });
    expect(executed).toEqual(["c1"]);
    expect(result.status === "done" && result.output).toEqual({
      results: [
        { id: "c1", status: "executed", result: "ran read" },
        { id: "c2", status: "rejected", reason: "not now" },
        { id: "c3", status: "rejected", reason: "denied by policy" },
      ],
      approveAlways: [],
    });
  });

  test("a verdict for a call not awaiting approval is ignored", async () => {
    const machine = createApprovalBatchMachine({
      policy: policyByName,
      execute: recordingExecute().execute,
    });
    const paused = await runToQuiescence(createAgentRuntime(machine), { input: { calls } });
    const result = await runToQuiescence(createAgentRuntime(machine), {
      snapshot: paused.persist(),
      // c3 was denied by policy; it cannot be approved into execution.
      event: { type: "APPROVE", callId: "c3" },
    });
    expect(result.status).toBe("idle");
    expect(result.ignored?.type).toBe("APPROVE");
  });

  test("execute failure lands as failed; empty batch finishes at once", async () => {
    const machine = createApprovalBatchMachine({
      policy: createAsyncLogic<ApprovalDecision, { call: ProposedCall }>({
        run: async () => "allow",
      }),
      execute: createAsyncLogic<never, { call: ProposedCall }>({
        run: async () => {
          throw new Error("disk full");
        },
      }),
    });
    const result = await runToQuiescence(createAgentRuntime(machine), {
      input: { calls: [calls[0]!] },
    });
    expect(result.status === "done" && result.output.results).toEqual([
      { id: "c1", status: "failed", error: "disk full" },
    ]);

    const empty = await runToQuiescence(createAgentRuntime(machine), { input: { calls: [] } });
    expect(empty.status === "done" && empty.output).toEqual({ results: [], approveAlways: [] });
  });

  test("runtime.send CANCEL_ALL stops a pending execute and ends the batch", async () => {
    let signal: AbortSignal | undefined;
    const machine = createApprovalBatchMachine({
      policy: policyByName,
      execute: createAsyncLogic<never, { call: ProposedCall }>({
        run: ({ signal: received }) => {
          signal = received;
          return new Promise<never>(() => {});
        },
      }),
      executeWhen: "eachReady",
    });
    const runtime = createAgentRuntime(machine);
    const settled = (async () => {
      let [state, effects] = await runtime.start({ input: { calls } });
      await runtime.execute(effects);
      for (let event; (event = await runtime.nextEvent());) {
        [state, effects] = runtime.transition(state, event);
        await runtime.execute(effects);
      }
      return runtime.finish();
    })();

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(signal?.aborted).toBe(false);
    expect(runtime.send({ type: "CANCEL_ALL" })).toBe(true);
    const result = await settled;

    expect(result.status).toBe("done");
    expect(result.snapshot.value).toBe("cancelled");
    expect(signal?.aborted).toBe(true);
    expect(result.status === "done" && result.output.results).toEqual([
      { id: "c1", status: "cancelled" },
      { id: "c2", status: "cancelled" },
      { id: "c3", status: "rejected", reason: "denied by policy" },
    ]);
  });

  test("duplicate call ids are rejected", async () => {
    const machine = createApprovalBatchMachine({ execute: recordingExecute().execute });
    const result = await runToQuiescence(createAgentRuntime(machine), {
      input: { calls: [calls[0]!, calls[0]!] },
    });
    expect(result.status).toBe("error");
  });
});

describe("approval-batch call machine: safety", () => {
  const callMachine = callMachineOf(
    createApprovalBatchMachine({ execute: recordingExecute().execute }),
  );
  const options = {
    input: { call: calls[2]! },
    outputs: { policy: ["allow", "ask", "deny", "bogus"], execute: ["ok"] },
    errors: { policy: new Error("policy down"), execute: new Error("boom") },
    payloads: () => ({ REJECT: [{}, { reason: "no" }] }),
  };

  // The sentinel: executing a call no policy allowed and no person approved.
  const executedWithoutApproval = (snapshot: {
    matches: (state: string) => boolean;
    context: { decision: string | null; approvedBy: string | null };
  }) =>
    (snapshot.matches("executing") || snapshot.matches("executed")) &&
    !(snapshot.context.decision === "allow" && snapshot.context.approvedBy === "policy") &&
    !(snapshot.context.decision === "ask" && snapshot.context.approvedBy === "user");

  test("executing without approval is unreachable (complete proof)", async () => {
    const result = await canReach(callMachine, executedWithoutApproval as never, options);
    expect(result).toEqual({ reachable: false, complete: true });
  });

  test("a denying policy never executes; an asking one needs a person", async () => {
    const denied = await canReach(callMachine, "executing", {
      ...options,
      outputs: { ...options.outputs, policy: ["deny"] },
    });
    expect(denied).toMatchObject({ reachable: false, complete: true });

    const asked = await canReach(callMachine, "executing", {
      ...options,
      outputs: { ...options.outputs, policy: ["ask"] },
      errors: {},
    });
    expect(asked.reachable).toBe(true);
    expect(asked.witness?.map((event) => event.type)).toContain("RELEASE");
    expect(
      asked.witness?.some((event) => event.type === "APPROVE" || event.type === "APPROVE_ALWAYS"),
    ).toBe(true);
  });
});

describe("approval-batch root: safety", () => {
  const machine = createApprovalBatchMachine({ execute: recordingExecute().execute });
  const options = {
    input: { calls: calls.slice(0, 2) },
    children: "explore" as const,
    childEvents: { call: ["APPROVE", "APPROVE_ALWAYS", "REJECT", "RELEASE"] },
    outputs: { policy: ["allow", "ask", "deny", "bogus"], execute: ["ok"] },
    errors: { policy: new Error("policy down"), execute: new Error("boom") },
    payloads: () => ({ REJECT: [{}, { reason: "no" }] }),
    dedupeBy: (snapshot: { value: unknown; context: unknown }) =>
      JSON.stringify([snapshot.value, snapshot.context]),
    maxDepth: 12,
    maxPaths: 10_000,
  };
  const executed = (snapshot: { context: { results: Record<string, { status: string }> } }) =>
    Object.values(snapshot.context.results).some((result) => result.status === "executed");

  test("the spawned calls are explored to completion from the root", async () => {
    const report = await explorePaths(machine, options);
    expect(isExplorationComplete(report)).toBe(true);
    expect(report.terminals.every((terminal) => terminal.state === "done")).toBe(true);
  });

  test("a denying policy never executes (complete proof at the root)", async () => {
    const result = await canReach(machine, executed as never, {
      ...options,
      outputs: { ...options.outputs, policy: ["deny"] },
    });
    expect(result).toEqual({ reachable: false, complete: true });
  });

  test("an approving policy executes", async () => {
    const result = await canReach(machine, executed as never, options);
    expect(result).toMatchObject({ reachable: true, complete: true });
  });
});

describe("approval-batch root: coupled children", () => {
  const machine = createApprovalBatchMachine({ execute: recordingExecute().execute });
  const two = calls.slice(0, 2);
  // The person answers the parent, which forwards to the awaiting call.
  const verdicts = () => ({
    APPROVE: two.map((call) => ({ callId: call.id })),
    APPROVE_ALWAYS: two.map((call) => ({ callId: call.id })),
    REJECT: two.map((call) => ({ callId: call.id })),
  });
  const options = {
    input: { calls: two },
    children: "coupled" as const,
    // Every event a call receives comes through the batch.
    childEvents: { call: [] },
    // CALL_ASKING and CALL_READY come only from the calls.
    hostEvents: ["APPROVE", "APPROVE_ALWAYS", "REJECT", "CANCEL_ALL"],
    outputs: { policy: ["allow", "ask"], execute: ["ok"] },
    errors: { execute: new Error("boom") },
    payloads: verdicts,
    dedupeBy: (snapshot: { value: unknown; context: unknown }) =>
      JSON.stringify([snapshot.value, snapshot.context]),
    maxDepth: 16,
    maxPaths: 10_000,
  };
  type Batch = {
    context: { results: Record<string, { status: string }>; awaiting: unknown[] };
  };
  const executed = (snapshot: Batch) =>
    Object.values(snapshot.context.results).some((result) => result.status === "executed");

  test("explored to completion from the root", async () => {
    const report = await explorePaths(machine, options);
    expect(isExplorationComplete(report)).toBe(true);
    // Every path settles: all calls land, or the person cancels the batch.
    expect(new Set(report.terminals.map((terminal) => terminal.state))).toEqual(
      new Set(["done", "cancelled"]),
    );
    expect(report.terminals.every((terminal) => terminal.status === "done")).toBe(true);
  });

  test("allReady: no call executes while another still awaits a person (complete proof)", async () => {
    const result = await canReach(
      machine,
      ((snapshot: Batch) => executed(snapshot) && snapshot.context.awaiting.length > 0) as never,
      options,
    );
    expect(result).toEqual({ reachable: false, complete: true });
  });

  test("the barrier is not vacuous: a call that asked still executes", async () => {
    const result = await canReach(machine, executed as never, {
      ...options,
      outputs: { ...options.outputs, policy: ["ask"] },
    });
    expect(result).toMatchObject({ reachable: true, complete: true });
    expect(result.witness?.some((event) => event.type === "APPROVE")).toBe(true);
  });

  test("'explore' cannot prove the barrier: its children run in any order", async () => {
    const result = await canReach(
      machine,
      ((snapshot: Batch) => executed(snapshot) && snapshot.context.awaiting.length > 0) as never,
      {
        ...options,
        children: "explore" as const,
        childEvents: { call: ["APPROVE", "APPROVE_ALWAYS", "REJECT", "RELEASE"] },
      },
    );
    expect(result.reachable).toBe(true);
  });
});
