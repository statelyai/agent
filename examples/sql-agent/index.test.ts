import { test } from "vitest";
import assert from "node:assert/strict";
import type { AgentTextRequest } from "@statelyai/agent";
import { executeQuery, runSqlAgentExample } from "./index.js";

// Routed on the request name (the `requests` key), not on the model id.
const generateText = async (request: AgentTextRequest) => {
  switch (request.name) {
    case "planQuery":
      return { output: { operation: "sum", column: "amount", category: "electronics" } };
    case "summarize":
      // The prompt carries the real computed result.
      return { output: `Answer: ${request.prompt}` };
    default:
      throw new Error(`Unexpected request '${request.name}'.`);
  }
};

const question = "What is the total amount spent on electronics?";

test("sql agent plans, awaits approval, executes the local engine, and summarizes", async () => {
  const { interaction, output } = await runSqlAgentExample(question, {
    executors: { generateText },
  });

  // The idle approval state exposed a typed interaction.
  assert.equal(interaction?.label, "Run this query against the orders table?");
  assert.deepEqual(interaction?.events, [
    { type: "APPROVE", label: "Approve", style: "primary" },
    { type: "REJECT", label: "Reject", style: "danger" },
  ]);

  // The local engine really ran: electronics amounts are 250 + 90 = 340.
  assert.equal(output.status, "answered");
  assert.deepEqual(output.plan, {
    operation: "sum",
    column: "amount",
    category: "electronics",
  });
  assert.equal(output.result, 340);
  assert.ok(output.answer.includes("340"));
});

test("the question reaches the planner instead of a hardcoded one", async () => {
  const prompts: (string | undefined)[] = [];
  await runSqlAgentExample("How many book orders are there?", {
    executors: {
      generateText: async (request) => {
        prompts.push(request.prompt);
        return generateText(request);
      },
    },
  });
  assert.equal(prompts[0], "How many book orders are there?");
});

test("rejecting the query short-circuits without executing", async () => {
  const { output } = await runSqlAgentExample(question, {
    executors: { generateText },
    approval: "REJECT",
  });
  assert.equal(output.status, "rejected");
  assert.equal(output.answer, "Query rejected by the reviewer.");
  assert.equal(output.result, null);
});

test("a planner failure ends in `failed`, not in a success-shaped output", async () => {
  const { output } = await runSqlAgentExample(question, {
    executors: {
      generateText: async () => {
        throw new Error("planner unavailable");
      },
    },
  });
  assert.equal(output.status, "failed");
  assert.equal(output.plan, null);
  assert.equal(output.result, null);
});

test("executeQuery is a genuine aggregate over the in-memory table", () => {
  assert.equal(executeQuery({ operation: "count", column: "amount", category: "books" }), 2);
  assert.equal(executeQuery({ operation: "average", column: "amount", category: "books" }), 21);
});
