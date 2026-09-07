import { expect, test } from "vitest";
import { isAgentIdle, provideExecutors } from "@statelyai/agent";
import { portableLoopMachine, runPortableXstateLoop } from "./index.js";

test("runs one artifact through XState's transition/effect loop, across a persistence boundary", async () => {
  const prompts: string[] = [];
  const result = await runPortableXstateLoop("snapshots", {
    generateText: async (request) => {
      prompts.push(request.prompt ?? "");
      return { output: "Snapshots make continuation explicit." };
    },
  });

  expect(prompts).toEqual(["Draft a release note about snapshots."]);
  expect(result).toEqual({
    draft: "Snapshots make continuation explicit.",
    failure: null,
    // The APPROVE was delivered to a second durable execution, rehydrated from
    // the JSON snapshot — not to the one that produced the draft.
    resumedFromSnapshot: true,
  });
});

test("the loop's stop condition is `isAgentIdle`, and `reviewing` satisfies it", () => {
  const machine = provideExecutors(portableLoopMachine, {
    generateText: async () => ({ output: "draft" }),
  });
  const reviewing = machine.resolveState({
    value: "reviewing",
    context: { topic: "snapshots", draft: "a draft", failure: null },
  });
  const drafting = machine.resolveState({
    value: "drafting",
    context: { topic: "snapshots", draft: "", failure: null },
  });

  expect(isAgentIdle(reviewing)).toBe(true);
  // `drafting` accepts no external event: it is working, not waiting.
  expect(isAgentIdle(drafting)).toBe(false);
});

test("a failing request ends in `failed` instead of hanging the loop", async () => {
  const result = await runPortableXstateLoop("snapshots", {
    generateText: async () => {
      throw new Error("writer offline");
    },
  });

  expect(result.resumedFromSnapshot).toBe(false);
  expect(result.draft).toBe("");
  expect(result.failure).toMatch(/^draft failed: /);
});
