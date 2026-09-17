import { test } from "vitest";
import assert from "node:assert/strict";
import type { AgentTextRequest, ChosenEvent } from "@statelyai/agent";
import { CLOSED_ROAD, planFrom, runRouteReplanningExample } from "./index.js";

test("plans the shortest route and follows it without recomputing", () => {
  // The plan is made once, from the depot, knowing nothing.
  assert.deepEqual(planFrom("depot", []), ["eastGate", "bridge", "market"]);
});

test("replans from where the courier is standing, not from the start", () => {
  // The closure is learned at the bridge, so the new route starts there — the
  // legs already driven are not replanned.
  assert.deepEqual(planFrom("bridge", [CLOSED_ROAD]), ["riverside", "market"]);
});

test("a closed road forces one replan and the delivery still completes", async () => {
  const emitted: string[] = [];
  const output = await runRouteReplanningExample({
    on: {
      "*": (event: { type: string }) => emitted.push(event.type),
    },
    executors: {
      decide: async () => ({
        // The dispatcher's one judgement call: take the detour.
        event: { type: "REROUTE", reasoning: "A detour exists and the budget allows it." },
      }),
      generateText: async (request: AgentTextRequest) => {
        assert.equal(request.name, "writeReport");
        return { result: "Delivered via the riverside after the bridge road closed." };
      },
    },
  });

  assert.equal(output.delivered, true);
  assert.equal(output.replans, 1);
  // Four legs: two on the original plan, two on the replan. The blocked
  // attempt is not a leg — the courier never left the bridge.
  assert.deepEqual(output.travelled, [
    "depot → eastGate",
    "eastGate → bridge",
    "bridge → riverside",
    "riverside → market",
  ]);
  // The run announces the plan forming, breaking, and reforming.
  assert.deepEqual(emitted, [
    "PLANNED",
    "ARRIVED",
    "ARRIVED",
    "BLOCKED",
    "REPLANNED",
    "ARRIVED",
    "ARRIVED",
  ]);
});

test("abandoning at the closure ends the run undelivered", async () => {
  const output = await runRouteReplanningExample({
    executors: {
      decide: async () => ({
        event: { type: "ABANDON", reasoning: "Not worth the detour." } as ChosenEvent,
      }),
      generateText: async () => ({ result: "Returned to the depot; the bridge was shut." }),
    },
  });

  assert.equal(output.delivered, false);
  assert.equal(output.replans, 0);
  assert.deepEqual(output.travelled, ["depot → eastGate", "eastGate → bridge"]);
});
