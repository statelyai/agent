import { describe, expect, test } from "vitest";
import { proposeApprovalRules, proposeCaps } from "./testing/index.js";

type TraceEvent = { type: string; [key: string]: unknown };
interface Pending {
  tool: string;
  path: string;
}

// One run: each pending call waits in `awaitingApproval`, then a person answers.
function approvalRun(verdicts: [Pending, "APPROVE" | "REJECT"][]): TraceEvent[] {
  const trace: TraceEvent[] = [
    { type: "run.start" },
    {
      type: "machine.transition",
      from: { value: "working" },
      snapshot: { value: "working", context: {} },
      event: { type: "@xstate.init" },
    },
  ];
  for (const [pending, verdict] of verdicts) {
    trace.push(
      {
        type: "machine.transition",
        from: { value: "working" },
        snapshot: { value: "awaitingApproval", context: { pending } },
        event: { type: "PROPOSE" },
      },
      {
        type: "machine.transition",
        from: { value: "awaitingApproval" },
        snapshot: { value: "working", context: {} },
        event: { type: verdict },
      },
    );
  }
  return trace;
}

const options = {
  approvalState: "awaitingApproval",
  approveEvents: ["APPROVE"],
  rejectEvents: ["REJECT"],
  key: ({ snapshot }: { snapshot: unknown }) => {
    const { tool, path } = (snapshot as { context: { pending: Pending } }).context.pending;
    return `${tool}:${path.startsWith("src/") ? "src/**" : path}`;
  },
};

describe("proposeApprovalRules", () => {
  const traces = [
    approvalRun([
      [{ tool: "write", path: "src/a.ts" }, "APPROVE"],
      [{ tool: "shell", path: "rm -rf" }, "REJECT"],
    ]),
    approvalRun([
      [{ tool: "write", path: "src/b.ts" }, "APPROVE"],
      [{ tool: "write", path: "package.json" }, "APPROVE"],
    ]),
    approvalRun([
      [{ tool: "write", path: "package.json" }, "REJECT"],
      [{ tool: "write", path: "src/c.ts" }, "APPROVE"],
    ]),
  ];

  test("never rejected qualifies for allow; one rejection blocks it", () => {
    expect(proposeApprovalRules(traces, options)).toEqual([
      {
        key: "write:src/**",
        approved: 3,
        rejected: 0,
        violations: 0,
        runs: [0, 1, 2],
        proposal: "allow",
        support: 3,
      },
      {
        key: "shell:rm -rf",
        approved: 0,
        rejected: 1,
        violations: 0,
        runs: [0],
        proposal: "deny",
        support: 1,
      },
      {
        key: "write:package.json",
        approved: 1,
        rejected: 1,
        violations: 0,
        runs: [1, 2],
        proposal: null,
        support: 2,
      },
    ]);
  });

  test("a recorded violation blocks allow", () => {
    const rows = proposeApprovalRules(traces, {
      ...options,
      violations: (trace) => (trace === traces[1] ? ["write:src/**"] : []),
    });
    expect(rows[0]).toMatchObject({ key: "write:src/**", violations: 1, proposal: null });
  });

  test("ignored events, other states, and skipped keys are not verdicts", () => {
    const trace = approvalRun([[{ tool: "write", path: "src/a.ts" }, "APPROVE"]]);
    trace.push(
      {
        type: "machine.transition",
        from: { value: "awaitingApproval" },
        snapshot: { value: "awaitingApproval", context: { pending: { tool: "x", path: "y" } } },
        event: { type: "REJECT" },
        ignored: true,
      },
      {
        type: "machine.transition",
        from: { value: "working" },
        snapshot: { value: "working", context: {} },
        event: { type: "REJECT" },
      },
    );
    expect(proposeApprovalRules([trace], options)).toMatchObject([
      { key: "write:src/**", approved: 1, rejected: 0 },
    ]);
    expect(proposeApprovalRules([trace], { ...options, key: () => undefined })).toEqual([]);
  });
});

describe("proposeCaps", () => {
  // A run that retried `retries` times and either finished or gave up.
  function capRun(retries: number, gaveUp: boolean): TraceEvent[] {
    return [
      ...Array.from({ length: retries }, () => ({
        type: "machine.transition",
        from: { value: "working" },
        snapshot: { value: "working" },
        event: { type: "RETRY" },
      })),
      {
        type: "machine.transition",
        from: { value: "working" },
        snapshot: { value: gaveUp ? "gaveUp" : "done" },
        event: { type: gaveUp ? "GIVE_UP" : "FINISH" },
      },
      { type: "run.end", status: "done", output: { ok: !gaveUp, retries } },
    ];
  }
  const countRetries = (trace: TraceEvent[]) =>
    trace.filter((e) => (e.event as { type?: string } | undefined)?.type === "RETRY").length;

  test("no hits: p95 of passing runs plus one, which may lower the cap", () => {
    const traces = [0, 1, 1, 2, 0].map((n) => capRun(n, false));
    expect(
      proposeCaps(traces, {
        caps: [{ name: "retries", current: 5, failureState: "gaveUp", valueFromRun: countRetries }],
      }),
    ).toEqual([{ name: "retries", hits: 0, passing: 5, max: 2, p95: 2, proposal: 3 }]);
  });

  test("hits: never proposed below the current cap", () => {
    const traces = [capRun(0, false), capRun(1, false), capRun(3, true), capRun(3, true)];
    const caps = [
      { name: "retries", current: 3, failureState: "gaveUp", valueFromRun: countRetries },
      {
        name: "by output",
        current: 3,
        failureOutput: (output: unknown) => !(output as { ok: boolean }).ok,
        valueFromRun: countRetries,
      },
    ];
    expect(proposeCaps(traces, { caps })).toEqual([
      { name: "retries", hits: 2, passing: 2, max: 3, p95: 1, proposal: 3 },
      { name: "by output", hits: 2, passing: 2, max: 3, p95: 1, proposal: 3 },
    ]);
  });

  test("no passing run proposes nothing", () => {
    expect(
      proposeCaps([capRun(3, true)], {
        caps: [{ name: "retries", failureState: "gaveUp", valueFromRun: countRetries }],
      }),
    ).toEqual([{ name: "retries", hits: 1, passing: 0, max: 3, p95: null, proposal: null }]);
  });
});
