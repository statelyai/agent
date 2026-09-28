import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { type AgentDecisionRequest } from "@statelyai/agent";
import { lintAgentMachine } from "@statelyai/agent/testing";
import { createMockModelExecutors, type MockModelScript } from "../mock-model.js";
import {
  MAX_CALLS_PER_WORKER,
  MAX_TURNS,
  agentSupervisorMachine,
  analyzeNotes,
  runAgentSupervisorExample,
} from "./index.js";

/**
 * Only the model is mocked, keyed by request name (`routeWork`,
 * `writeResearchReport`, `writeAnalysisReport`). The note lookup and the
 * analysis run their real code over SAMPLE_NOTES.
 */
function scripted(script: MockModelScript) {
  const executors = createMockModelExecutors(script);
  return { generateText: executors.generateText, decide: executors.decide, calls: executors.calls };
}

const workerText = {
  writeResearchReport: ["Q2 revenue was 160, 170 and 185 thousand dollars."],
  writeAnalysisReport: ["Average Q2 monthly revenue: 171.67 thousand dollars."],
};

test("happy path: research, then code, then FINISH", async () => {
  const executors = scripted({
    text: workerText,
    decisions: {
      routeWork: [
        { type: "DELEGATE_RESEARCH" },
        { type: "DELEGATE_CODE" },
        { type: "FINISH", answer: "Q2 averaged 171.67 thousand dollars a month." },
      ],
    },
  });
  const result = await runAgentSupervisorExample({
    task: "What was the Lumen lamp's average monthly revenue in Q2?",
    generateText: executors.generateText,
    decide: executors.decide,
  });

  expect(result.outcome).toBe("done");
  expect(result.answer).toBe("Q2 averaged 171.67 thousand dollars a month.");
  expect(result.turns).toBe(2);
  expect(result.reports.map((entry) => [entry.worker, entry.status])).toEqual([
    ["researcher", "done"],
    ["coder", "done"],
  ]);
  expect(result.progress).toEqual([
    "supervising",
    "researching",
    "supervising",
    "coding",
    "supervising",
    "done",
  ]);
  expect(result.trail.at(-1)).toBe("The supervisor finished the task.");

  // The tools ran for real and their results reached the worker requests.
  const research = executors.calls.find((call) => call.name === "writeResearchReport");
  expect(JSON.stringify(research?.input)).toContain("[sample note] Lumen lamp Q2 revenue");
  const analysis = executors.calls.find((call) => call.name === "writeAnalysisReport");
  expect(JSON.stringify(analysis?.input)).toContain("q2-revenue: n=3, sum=515, average=171.67");
  // The coder sees the researcher's report.
  expect(JSON.stringify(analysis?.input)).toContain("researcher: Q2 revenue was");
});

test("FINISH is rejected until a worker has reported", async () => {
  const executors = scripted({
    text: workerText,
    decisions: {
      routeWork: [
        // First decision: FINISH with nothing reported is rejected by the guard,
        // so the retry takes the next entry.
        { type: "FINISH", answer: "guessing" },
        { type: "DELEGATE_RESEARCH" },
        { type: "FINISH", answer: "Revenue grew each month of Q2." },
      ],
    },
  });
  const result = await runAgentSupervisorExample({
    generateText: executors.generateText,
    decide: executors.decide,
  });

  expect(result.outcome).toBe("done");
  expect(result.answer).toBe("Revenue grew each month of Q2.");
  expect(result.turns).toBe(1);
  expect(executors.calls.filter((call) => call.kind === "decide")).toHaveLength(3);
});

test("a worker cannot be picked after MAX_CALLS_PER_WORKER reports", async () => {
  const executors = scripted({
    text: workerText,
    decisions: {
      // Always asks for research; once the allowance is spent the guard rejects
      // it and the retry (attempts non-empty) picks FINISH.
      routeWork: (request: AgentDecisionRequest) =>
        request.attempts.length > 0
          ? { type: "FINISH", answer: "Enough research." }
          : { type: "DELEGATE_RESEARCH" },
    },
  });
  const result = await runAgentSupervisorExample({
    generateText: executors.generateText,
    decide: executors.decide,
  });

  expect(result.outcome).toBe("done");
  expect(result.reports.filter((entry) => entry.worker === "researcher")).toHaveLength(
    MAX_CALLS_PER_WORKER,
  );
  expect(executors.calls.filter((call) => call.name === "writeResearchReport")).toHaveLength(
    MAX_CALLS_PER_WORKER,
  );
});

test("a supervisor with no legal choice ends in failed", async () => {
  const executors = scripted({
    text: workerText,
    // FINISH before any report, every time: every attempt is rejected.
    decisions: { routeWork: [{ type: "FINISH", answer: "nothing yet" }] },
  });
  const result = await runAgentSupervisorExample({
    generateText: executors.generateText,
    decide: executors.decide,
  });

  expect(result.outcome).toBe("failed");
  expect(result.progress).toEqual(["supervising", "failed"]);
  expect(result.answer).toContain("No final answer: The supervisor made no legal routing choice.");
  expect(result.answer).toContain("No worker reported.");
});

test("a failing worker burns turns until MAX_TURNS lands in failed", async () => {
  const executors = scripted({
    text: {
      writeResearchReport: () => {
        throw new Error("provider unavailable");
      },
      writeAnalysisReport: workerText.writeAnalysisReport,
    },
    // FINISH is never legal (no successful report), and failed reports do not
    // use up the researcher's allowance, so only the turn budget stops this.
    decisions: { routeWork: [{ type: "DELEGATE_RESEARCH" }] },
  });
  const result = await runAgentSupervisorExample({
    generateText: executors.generateText,
    decide: executors.decide,
  });

  expect(result.outcome).toBe("failed");
  expect(result.turns).toBe(MAX_TURNS);
  expect(result.reports).toHaveLength(MAX_TURNS);
  expect(result.reports.every((entry) => entry.status === "failed")).toBe(true);
  expect(result.reports[0]?.report).toContain("provider unavailable");
  expect(result.answer).toContain(
    `Turn budget spent: ${MAX_TURNS} delegations without a usable report`,
  );
  expect(result.progress.filter((state) => state === "researching")).toHaveLength(MAX_TURNS);
  expect(result.progress.at(-1)).toBe("failed");
});

test("the last permitted delegation can still end in FINISH", async () => {
  // One flaky research call, then two good research reports and two good
  // analysis reports: MAX_TURNS delegations, the last of which succeeds.
  let researchCalls = 0;
  const executors = scripted({
    text: {
      writeResearchReport: () => {
        researchCalls += 1;
        if (researchCalls === 1) throw new Error("provider unavailable");
        return workerText.writeResearchReport[0]!;
      },
      writeAnalysisReport: workerText.writeAnalysisReport,
    },
    decisions: {
      routeWork: [
        { type: "DELEGATE_RESEARCH" },
        { type: "DELEGATE_RESEARCH" },
        { type: "DELEGATE_RESEARCH" },
        { type: "DELEGATE_CODE" },
        { type: "DELEGATE_CODE" },
        { type: "FINISH", answer: "Q2 averaged 171.67 thousand dollars a month." },
      ],
    },
  });
  const result = await runAgentSupervisorExample({
    generateText: executors.generateText,
    decide: executors.decide,
  });

  expect(result.outcome).toBe("done");
  expect(result.turns).toBe(MAX_TURNS);
  expect(result.reports.at(-1)).toMatchObject({ worker: "coder", status: "done" });
  expect(result.answer).toBe("Q2 averaged 171.67 thousand dollars a month.");
  // At the cap, FINISH is the only event the supervisor is offered.
  const last = executors.calls.filter((call) => call.kind === "decide").at(-1)!;
  expect((last.request as AgentDecisionRequest).events.map((event) => event.type)).toEqual([
    "FINISH",
  ]);
});

test("starters behave as their labels advertise", async () => {
  const starters = JSON.parse(readFileSync(new URL("./metadata.json", import.meta.url), "utf8"))
    .starters as string[];
  expect(starters).toHaveLength(3);

  // Each starter's task lands on exactly one numeric series in the sample notes.
  expect(analyzeNotes(starters[0]!)).toEqual([
    "[sample analysis] q2-revenue: n=3, sum=515, average=171.67",
  ]);
  expect(analyzeNotes(starters[1]!)).toEqual([
    "[sample analysis] q2-churn: n=3, sum=8.5, average=2.83",
  ]);
  expect(analyzeNotes(starters[2]!)).toEqual([
    "[sample analysis] q2-support: n=4, sum=156, average=39",
  ]);

  for (const task of starters) {
    const executors = scripted({
      text: workerText,
      decisions: {
        routeWork: [
          { type: "DELEGATE_RESEARCH" },
          { type: "DELEGATE_CODE" },
          { type: "FINISH", answer: "done" },
        ],
      },
    });
    const result = await runAgentSupervisorExample({
      task,
      generateText: executors.generateText,
      decide: executors.decide,
    });
    expect(result.outcome).toBe("done");
    const research = executors.calls.find((call) => call.name === "writeResearchReport");
    expect(JSON.stringify(research?.input)).not.toContain("No notes matched");
  }
});

test("lint is clean", () => {
  expect(() => lintAgentMachine(agentSupervisorMachine, { throw: true })).not.toThrow();
});
