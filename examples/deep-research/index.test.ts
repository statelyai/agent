import { expect, test } from "vitest";
import { runDeepResearchExample } from "./index.js";

test("plans, researches in parallel, reflects, and writes", async () => {
  const calls: string[] = [];
  const output = await runDeepResearchExample({
    question: "durability",
    maxRounds: 2,
    generateText: async (request) => {
      calls.push(request.model);
      if (request.model === "planner") {
        return { output: { queries: ["snapshots", "event logs", "retries"] } };
      }
      if (request.model === "researcher") return { output: `finding for ${request.prompt}` };
      if (request.model === "reflector") return { output: { sufficient: true, gaps: "" } };
      return { output: "Durable workflows combine snapshots, events, and bounded retries." };
    },
  });

  expect(calls.filter((model) => model === "researcher")).toHaveLength(3);
  expect(output.rounds).toBe(1);
  expect(output.report).toContain("snapshots");
  expect(Object.values(output.findings).every(Boolean)).toBe(true);
});

test("runs one targeted follow-up round when reflection finds a gap", async () => {
  let reflections = 0;
  const output = await runDeepResearchExample({
    question: "durability",
    maxRounds: 2,
    generateText: async (request) => {
      if (request.model === "planner") {
        return { output: { queries: ["one", "two", "three"] } };
      }
      if (request.model === "researcher") return { output: "evidence [source]" };
      if (request.model === "reflector") {
        reflections++;
        return { output: { sufficient: reflections === 2, gaps: "failure recovery" } };
      }
      return { output: "Final report [source]" };
    },
  });

  expect(output.rounds).toBe(2);
  expect(reflections).toBe(2);
});
