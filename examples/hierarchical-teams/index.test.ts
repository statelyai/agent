import { expect, test } from "vitest";
import type { AgentDecisionRequest, ChosenEvent } from "@statelyai/agent";
import { hierarchicalTeamsMachine, runHierarchicalTeamsExample } from "./index.js";

const WORKER_RESPONSES: Record<string, string> = {
  searcher: "source A; source B",
  scraper: "Explicit states expose retries and approval gates.",
  outliner: "1. Reliability\n2. Inspection",
  writer: "Explicit workflow state makes reliability behavior inspectable.",
};

// The research supervisor is the decision whose candidates include FINISH; the
// coordinator supervisor's candidates are REVISE/PUBLISH. Route by that.
const isResearchDecision = (request: AgentDecisionRequest): boolean =>
  request.events.some((event) => event.type === "FINISH");

test("research supervisor routes SEARCH → SCRAPE → FINISH, looping workers", async () => {
  const workerCalls: string[] = [];
  let researchDecisions = 0;
  const researchScript = ["SEARCH", "SCRAPE", "FINISH"];

  const output = await runHierarchicalTeamsExample({
    generateText: async (request) => {
      workerCalls.push(request.model);
      return { output: WORKER_RESPONSES[request.model] };
    },
    decide: async (request: AgentDecisionRequest): Promise<{ event: ChosenEvent }> => {
      if (isResearchDecision(request)) {
        const type = researchScript[researchDecisions] ?? "FINISH";
        researchDecisions += 1;
        return { event: { type } };
      }
      // Coordinator accepts the first draft.
      return { event: { type: "PUBLISH" } };
    },
  });

  // The supervisor looped both workers in the order it chose, then the writing
  // team ran — worker call order reflects the routing, not a fixed pipeline.
  expect(workerCalls).toEqual(["searcher", "scraper", "outliner", "writer"]);
  expect(researchDecisions).toBe(3); // SEARCH, SCRAPE, FINISH
  expect(output.details.research).toContain("approval gates");
  expect(output.details.report).toContain("inspectable");

  // The team tree leads: one line per team, indented one line per worker, and
  // the coordinator's verdict.
  expect(output.teamReport.split("\n").slice(0, 6)).toEqual([
    "research team",
    "  search. done. source A; source B",
    "  scrape. done. Explicit states expose retries and approval gates.",
    "writing team",
    "  outline. done. 1. Reliability 2. Inspection",
    "  write. done. Explicit workflow state makes reliability behavior inspectable.",
  ]);
  expect(output.teamReport).toContain("coordinator. publish");
  // The report sits under the tree, so the tree string always leads.
  expect(output.teamReport).toContain("Report\nExplicit workflow state");
  expect(output.teamReport.length).toBeGreaterThan(output.details.report.length);
});

test("worker-step budget bounds the research loop", async () => {
  const workerCalls: string[] = [];

  const output = await runHierarchicalTeamsExample({
    generateText: async (request) => {
      workerCalls.push(request.model);
      return { output: WORKER_RESPONSES[request.model] ?? "note" };
    },
    // The research supervisor never stops on its own — it always asks to
    // SEARCH. The budget (2) must force FINISH once exhausted.
    decide: async (request: AgentDecisionRequest): Promise<{ event: ChosenEvent }> => {
      if (isResearchDecision(request)) return { event: { type: "SEARCH" } };
      return { event: { type: "PUBLISH" } };
    },
  });

  // Exactly `budget` searches ran before the loop was forced to end; the
  // supervisor never chose SCRAPE.
  expect(workerCalls.filter((model) => model === "searcher")).toHaveLength(2);
  expect(workerCalls).not.toContain("scraper");
  // The coordinator still published a report from what was gathered.
  expect(output.details.report).toContain("inspectable");
});

test("coordinator supervisor sends one bounded revision round back to research", async () => {
  const workerCalls: string[] = [];
  let coordinatorDecisions = 0;

  const output = await runHierarchicalTeamsExample({
    generateText: async (request) => {
      workerCalls.push(request.model);
      return { output: WORKER_RESPONSES[request.model] ?? "note" };
    },
    decide: async (request: AgentDecisionRequest): Promise<{ event: ChosenEvent }> => {
      if (isResearchDecision(request)) return { event: { type: "FINISH" } };
      coordinatorDecisions += 1;
      // REVISE once, then PUBLISH (the second round is capped by the budget).
      return { event: { type: coordinatorDecisions === 1 ? "REVISE" : "PUBLISH" } };
    },
  });

  // One REVISE + one PUBLISH; the writing team ran twice (revision round).
  expect(coordinatorDecisions).toBe(2);
  expect(workerCalls.filter((model) => model === "outliner")).toHaveLength(2);

  // The tree records the revision round as its own labelled block.
  expect(output.teamReport).toContain("coordinator. revise");
  expect(output.teamReport).toContain("research team (revision)");
  expect(output.teamReport.match(/^writing team$/gm)).toHaveLength(2);
});

test("machine exports a runnable definition", () => {
  expect(hierarchicalTeamsMachine.id).toBe("hierarchical-teams");
});
