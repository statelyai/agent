import { test } from "vitest";
import assert from "node:assert/strict";
import type { AgentTextRequest } from "@statelyai/agent";
import { executeQuery, runSqlAgentExample } from "./index.js";

const generateText = async (request: AgentTextRequest) => {
  if (request.model === "planner") {
    return {
      output: { operation: "sum", column: "amount", category: "electronics" },
    };
  }
  // summarizer — its prompt carries the real computed result.
  return { output: `Answer: ${request.prompt}` };
};

test("sql agent plans, awaits approval, executes the local engine, and summarizes", async () => {
  const { interaction, output } = await runSqlAgentExample({ executors: { generateText } });

  // The idle approval state exposed a typed interaction.
  assert.equal(interaction?.type, "select");
  assert.equal(interaction?.label, "Run this query against the orders table?");

  // The local engine really ran: electronics amounts are 250 + 90 = 340.
  assert.deepEqual(output.plan, {
    operation: "sum",
    column: "amount",
    category: "electronics",
  });
  assert.equal(output.result, 340);
  assert.ok(output.answer.includes("340"));
});

test("rejecting the query short-circuits without executing", async () => {
  const { output } = await runSqlAgentExample({
    executors: { generateText },
    approval: "REJECT",
  });
  assert.equal(output.answer, "Query rejected by the reviewer.");
  assert.equal(output.result, 0);
});

test("executeQuery is a genuine aggregate over the in-memory table", () => {
  assert.equal(executeQuery({ operation: "count", column: "amount", category: "books" }), 2);
  assert.equal(executeQuery({ operation: "average", column: "amount", category: "books" }), 21);
});
