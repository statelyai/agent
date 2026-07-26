import { expect, test } from "vitest";
import { runTradingTeamExample, tradingTeamMachine } from "./index.js";

type Req = { model: string; system?: string; prompt?: string };

// Route the one `generateText` executor on `request.model` (the alias from
// `defineModels`). Only the model calls are mocked — the debate loop, the
// rejection loop, and every guard run for real. `trader`/`portfolio` are
// scripted per-invocation so a test can force rejections; `researcher` derives
// its stance from the system prompt so alternation is observable.
function mockExecutor(scripts: {
  trader: Array<{ action: string; rationale: string }>;
  portfolio: Array<{ approved: boolean; action: string; reason: string }>;
  risk?: { acceptable: boolean; concerns: string[] };
}) {
  const cursors = { trader: 0, portfolio: 0 };
  const calls: Req[] = [];
  const generateText = async (request: Req) => {
    calls.push(request);
    switch (request.model) {
      case "analyst":
        return { output: "mixed evidence" };
      case "researcher":
        return { output: request.system?.includes("bull") ? "bull argument" : "bear argument" };
      case "trader": {
        const next = scripts.trader[cursors.trader] ?? scripts.trader.at(-1);
        cursors.trader++;
        return { output: next };
      }
      case "risk":
        return { output: scripts.risk ?? { acceptable: true, concerns: ["limited sample"] } };
      default: {
        const next = scripts.portfolio[cursors.portfolio] ?? scripts.portfolio.at(-1);
        cursors.portfolio++;
        return { output: next };
      }
    }
  };
  return { generateText, calls };
}

test("bull and bear alternate for maxDebateRounds, appending to the transcript", async () => {
  const { generateText, calls } = mockExecutor({
    trader: [{ action: "hold", rationale: "mixed" }],
    portfolio: [{ approved: true, action: "hold", reason: "acceptable" }],
  });

  const result = await runTradingTeamExample({ maxDebateRounds: 2, generateText });

  // Three specialists ran in parallel first.
  expect(calls.filter((c) => c.model === "analyst")).toHaveLength(3);

  // 2 rounds × (bull + bear) = 4 debate turns, strictly alternating.
  const debate = result.progress.filter((s) => s === "bullArguing" || s === "bearArguing");
  expect(debate).toEqual(["bullArguing", "bearArguing", "bullArguing", "bearArguing"]);
  expect(debate).toHaveLength(2 * 2);

  const stances = calls
    .filter((c) => c.model === "researcher")
    .map((c) => (c.system?.includes("bull") ? "bull" : "bear"));
  expect(stances).toEqual(["bull", "bear", "bull", "bear"]);

  // A bear turn sees the bull's latest argument in its transcript (real rebuttal).
  const firstBear = calls.find((c) => c.model === "researcher" && c.system?.includes("bear"));
  expect(firstBear?.prompt).toContain("bull argument");

  expect(result.outcome).toBe("approved");
  expect(result.revisions).toBe(0);
  expect(result.progress.at(-1)).toBe("done");
});

test("a rejected decision loops back to a revised proposal, then approves", async () => {
  const { generateText, calls } = mockExecutor({
    trader: [
      { action: "buy", rationale: "aggressive" },
      { action: "hold", rationale: "revised after rejection" },
    ],
    portfolio: [
      { approved: false, action: "buy", reason: "unsupported upside" },
      { approved: true, action: "hold", reason: "revision is acceptable" },
    ],
  });

  const result = await runTradingTeamExample({ generateText });

  // proposing entered twice: original + the one allowed revision.
  expect(result.progress.filter((s) => s === "proposing")).toHaveLength(2);
  const proposeCalls = calls.filter((c) => c.model === "trader");
  expect(proposeCalls).toHaveLength(2);
  // The revision proposal carries the rejection reason forward.
  expect(proposeCalls[1]?.prompt).toContain("unsupported upside");

  expect(result.outcome).toBe("approved");
  expect(result.revisions).toBe(1);
  expect(result.action).toBe("hold");
  expect(result.progress.at(-1)).toBe("done");
});

test("a second rejection terminates in the rejected outcome (not an error)", async () => {
  const { generateText } = mockExecutor({
    trader: [
      { action: "buy", rationale: "aggressive" },
      { action: "buy", rationale: "still aggressive" },
    ],
    portfolio: [
      { approved: false, action: "buy", reason: "too risky" },
      { approved: false, action: "buy", reason: "still too risky" },
    ],
  });

  const result = await runTradingTeamExample({ generateText });

  // One revision allowed → proposing twice; the second rejection stops the loop.
  expect(result.progress.filter((s) => s === "proposing")).toHaveLength(2);
  expect(result.outcome).toBe("rejected");
  expect(result.revisions).toBe(2);
  expect(result.reason).toBe("still too risky");
  expect(result.progress.at(-1)).toBe("rejected");
});

test("machine exports a runnable definition", () => {
  expect(tradingTeamMachine.id).toBe("trading-team");
});
