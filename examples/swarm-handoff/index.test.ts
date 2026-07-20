import { test } from "vitest";
import assert from "node:assert/strict";
import type { AgentTextRequest } from "@statelyai/agent";
import { runSwarmHandoffExample } from "./index.js";

test("swarm handoff switches the active agent and persists it across a round-trip", async () => {
  const { travel, food } = await runSwarmHandoffExample({
    executors: {
      generateText: async (request: AgentTextRequest) => ({
        output: `[${request.model}] ${request.prompt}`,
      }),
    },
  });

  // Turn 1: travel agent answered.
  assert.equal(travel.activeAgent, "travel");
  assert.equal(travel.reply, "[travel] I want a 3-day trip to Lisbon.");

  // Turn 2: HANDOFF moved the mic to the food agent, and the resumed snapshot
  // routed to it (proving activeAgent survived the JSON round-trip).
  assert.equal(food.activeAgent, "food");
  assert.equal(food.reply, "[food] What are the must-try dishes there?");
});
