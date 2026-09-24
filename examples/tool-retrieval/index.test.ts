import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { type AgentDecisionRequest } from "@statelyai/agent";
import { lintAgentMachine } from "@statelyai/agent/testing";
import { createMockModelExecutors, type MockDecisionEntry } from "../mock-model.js";
import {
  MAX_RESELECTIONS,
  MAX_TOOL_CALLS,
  TOOL_REGISTRY,
  runToolRetrievalExample,
  toolRetrievalMachine,
} from "./index.js";

/** Mock only the model: the `chooseTool` decision, keyed by name. */
function scripted(chooseTool: MockDecisionEntry | MockDecisionEntry[]) {
  return createMockModelExecutors({ decisions: { chooseTool } }).decide;
}

const rejected = (request: AgentDecisionRequest) =>
  new Set(request.attempts.map((attempt) => attempt.event?.type));

test("selects matching tools → calls one → answers", async () => {
  const result = await runToolRetrievalExample({
    question: "How many miles is a 42.195 km marathon?",
    decide: scripted([
      { type: "CALL_TOOL", tool: "km_to_miles", arg: "42.195" },
      { type: "ANSWER", answer: "About 26.22 miles." },
    ]),
  });

  expect(result.finalState).toBe("done");
  expect(result.selectedTools).toEqual(["km_to_miles"]);
  expect(result.calls).toBe('km_to_miles("42.195") → 26.22 miles');
  expect(result.answer).toBe("About 26.22 miles.");
  expect(result.progress).toEqual([
    "selectingTools",
    "deciding",
    "runningTool",
    "deciding",
    "done",
  ]);
});

test("a registry tool outside the selected set is rejected, and the decision retries", async () => {
  const seen: string[][] = [];
  const result = await runToolRetrievalExample({
    question: "How many miles is a 42.195 km marathon?",
    decide: scripted((request) => {
      seen.push(request.attempts.map((attempt) => attempt.failure));
      return request.attempts.length === 0
        ? { type: "CALL_TOOL", tool: "lookup_capital", arg: "Japan" }
        : { type: "ANSWER", answer: "Unsure." };
    }),
  });

  expect(result.finalState).toBe("done");
  expect(seen).toEqual([[], ["rejected-by-guard"]]);
  expect(result.progress).not.toContain("runningTool");
  expect(result.calls).toBe("(no tool calls)");
});

test("RESELECT searches again and ADDS the new tools to the selected set", async () => {
  const result = await runToolRetrievalExample({
    question: "How many miles is a 42.195 km marathon?",
    decide: scripted([
      { type: "RESELECT", query: "capital city of a country" },
      { type: "CALL_TOOL", tool: "lookup_capital", arg: "Kenya" },
      { type: "ANSWER", answer: "Nairobi." },
    ]),
  });

  expect(result.finalState).toBe("done");
  expect(result.reselections).toBe(1);
  expect(result.selectedTools).toEqual(["km_to_miles", "lookup_capital"]);
  expect(result.calls).toBe('lookup_capital("Kenya") → Nairobi');
  expect(result.progress.slice(0, 4)).toEqual([
    "selectingTools",
    "deciding",
    "selectingTools",
    "deciding",
  ]);
});

test("reselection budget: RESELECT is refused after MAX_RESELECTIONS, so the model answers", async () => {
  const result = await runToolRetrievalExample({
    question: "What is the capital of Australia?",
    decide: scripted((request) =>
      rejected(request).has("RESELECT")
        ? { type: "ANSWER", answer: "Canberra, from memory." }
        : { type: "RESELECT", query: "capital" },
    ),
  });

  expect(result.finalState).toBe("done");
  expect(result.reselections).toBe(MAX_RESELECTIONS);
  expect(result.progress.filter((state) => state === "selectingTools")).toHaveLength(
    MAX_RESELECTIONS + 1,
  );
});

test("tool-call budget exhausted and the model never answers → failed", async () => {
  const result = await runToolRetrievalExample({
    question: "How many miles is a 42.195 km marathon?",
    decide: scripted({ type: "CALL_TOOL", tool: "km_to_miles", arg: "1" }),
  });

  expect(result.finalState).toBe("failed");
  expect(result.calls.split("\n")).toHaveLength(MAX_TOOL_CALLS);
  expect(result.answer).toContain(`after ${MAX_TOOL_CALLS} tool call(s)`);
});

test("registry tools are pure and report bad arguments instead of throwing", () => {
  const run = (name: string, arg: string) =>
    TOOL_REGISTRY.find((tool) => tool.name === name)!.run(arg);
  expect(TOOL_REGISTRY).toHaveLength(12);
  expect(run("days_between", "2026-01-15 2026-03-01")).toBe("45 days");
  expect(run("add_days", "2026-01-15 30")).toBe("2026-02-14");
  expect(run("percent_of", "15 of 80")).toBe("12");
  expect(run("sum_numbers", "3, 4.5, 10")).toBe("17.5");
  expect(run("celsius_to_fahrenheit", "100")).toBe("212 °F");
  expect(run("km_to_miles", "far")).toMatch(/^error:/);
  expect(run("days_between", "soon")).toMatch(/^error:/);
});

test("machine lints clean", () => {
  expect(() => lintAgentMachine(toolRetrievalMachine, { throw: true })).not.toThrow();
});

const starters = JSON.parse(readFileSync(new URL("./metadata.json", import.meta.url), "utf8"))
  .starters as string[];

test("starters behave as their labels advertise", async () => {
  // Each starter question is answerable by one registry tool, and the keyword
  // selector must surface that tool on the FIRST selection.
  const expected = [
    { tool: "km_to_miles", arg: "42.195", result: "26.22 miles" },
    { tool: "days_between", arg: "2026-01-15 2026-03-01", result: "45 days" },
    { tool: "lookup_capital", arg: "Australia", result: "Canberra" },
  ];
  for (const [index, question] of starters.entries()) {
    const { tool, arg, result: toolResult } = expected[index]!;
    const result = await runToolRetrievalExample({
      question,
      decide: scripted([
        { type: "CALL_TOOL", tool, arg },
        { type: "ANSWER", answer: "done" },
      ]),
    });
    expect(result.finalState, question).toBe("done");
    expect(result.reselections, question).toBe(0);
    expect(result.selectedTools, question).toContain(tool);
    expect(result.calls, question).toBe(`${tool}(${JSON.stringify(arg)}) → ${toolResult}`);
  }
});
