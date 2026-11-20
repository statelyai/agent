import { describe, expect, test } from "vitest";
import { canReach } from "@statelyai/agent/testing";
import {
  approveToolCallsMachine,
  runApproveToolCallsExample,
  ruleMatches,
  type ApprovalRule,
  type ProposedCall,
} from "./index.js";

const npmTest: ProposedCall = { id: "c1", tool: "runCommand", args: { cmd: "npm test" } };
const npmTestAgain: ProposedCall = { ...npmTest, id: "c2" };
const wipe: ProposedCall = { id: "c3", tool: "runCommand", args: { cmd: "rm -rf ~" } };

describe("approve-tool-calls", () => {
  test("approve-always covers the same call later in the batch, not a different one", async () => {
    const ran: string[] = [];
    const result = await runApproveToolCallsExample({
      calls: [npmTest, npmTestAgain, wipe],
      verdicts: [{ type: "APPROVE_ALWAYS" }, { type: "DENY", reason: "never" }],
      run: async (call) => ran.push(call.id),
    });

    expect(ran).toEqual(["c1", "c2"]);
    expect(result.asked).toEqual([
      'Run runCommand(cmd="npm test")?',
      'Run runCommand(cmd="rm -rf ~")?',
    ]);
    expect(result.results.map(({ id, status, by }) => ({ id, status, by }))).toEqual([
      { id: "c1", status: "executed", by: "person" },
      { id: "c2", status: "executed", by: "rule" },
      { id: "c3", status: "denied", by: undefined },
    ]);
    expect(result.rules).toEqual([{ tool: "runCommand", args: { cmd: "npm test" } }]);
  });

  test("a rule matches the same arguments in any key order", async () => {
    const write: ProposedCall = {
      id: "w2",
      tool: "writeFile",
      args: { content: "hello", path: "a.txt", meta: { b: 1, a: [1, 2] } },
    };
    const result = await runApproveToolCallsExample({
      calls: [write],
      rules: [
        { tool: "writeFile", args: { path: "a.txt", meta: { a: [1, 2], b: 1 }, content: "hello" } },
      ],
      verdicts: [],
    });
    expect(result.results.map(({ status, by }) => ({ status, by }))).toEqual([
      { status: "executed", by: "rule" },
    ]);
    expect(
      ruleMatches(
        { tool: "writeFile", args: { meta: { a: [2, 1] } } },
        {
          id: "w3",
          tool: "writeFile",
          args: { meta: { a: [1, 2] } },
        },
      ),
    ).toBe(false);
    for (const [ruleValue, callValue] of [
      [Number.NaN, null],
      [null, undefined],
      [Number.POSITIVE_INFINITY, null],
    ]) {
      expect(
        ruleMatches(
          { tool: "fetch", args: { limit: ruleValue } },
          { id: "f1", tool: "fetch", args: { limit: callValue } },
        ),
      ).toBe(false);
    }
    expect(
      ruleMatches(
        { tool: "fetch", args: { limit: Number.NaN } },
        {
          id: "f2",
          tool: "fetch",
          args: { limit: Number.NaN },
        },
      ),
    ).toBe(true);
  });

  test("calls run in proposal order and a failure does not stop the batch", async () => {
    const ran: string[] = [];
    const result = await runApproveToolCallsExample({
      calls: [wipe, npmTest],
      rules: [{ tool: "runCommand", args: { cmd: "npm test" } }],
      verdicts: [{ type: "APPROVE" }],
      run: async (call) => {
        ran.push(call.id);
        if (call.id === "c3") throw new Error("refused");
        return "ok";
      },
    });

    expect(ran).toEqual(["c3", "c1"]);
    expect(result.results.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "c3", status: "failed" },
      { id: "c1", status: "executed" },
    ]);
  });

  describe("safety", () => {
    const rules: ApprovalRule[] = [{ tool: "runCommand", args: { cmd: "npm test" } }];
    const options = {
      input: { calls: [npmTest, wipe], rules },
      outputs: { runTool: ["ok"] },
      errors: { runTool: new Error("boom") },
      payloads: () => ({ DENY: [{}, { reason: "no" }] }),
    };
    const wipeRuns = (snapshot: {
      matches: (state: string) => boolean;
      context: { cursor: number };
    }) => snapshot.matches("running") && snapshot.context.cursor === 1;

    test("without a person's approval, only rule-matched calls run (complete proof)", async () => {
      const result = await canReach(approveToolCallsMachine, wipeRuns as never, {
        ...options,
        hostEvents: ["DENY"],
      });
      expect(result).toEqual({ reachable: false, complete: true });
    });

    test("a person's approval runs it", async () => {
      const result = await canReach(approveToolCallsMachine, wipeRuns as never, options);
      expect(result.reachable).toBe(true);
      expect(result.witness?.at(-1)?.type).toBe("APPROVE");
    });
  });
});
