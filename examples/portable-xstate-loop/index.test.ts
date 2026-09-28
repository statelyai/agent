import { expect, test } from "vitest";
import { handleTurn, runPortableXstateLoop } from "./index.js";

test("runs one artifact across a persistence boundary, one stateless turn at a time", async () => {
  const prompts: string[] = [];
  const result = await runPortableXstateLoop("snapshots", {
    generateText: async (request) => {
      prompts.push(request.prompt ?? "");
      return { result: "Snapshots make continuation explicit." };
    },
  });

  expect(prompts).toEqual(["Draft a release note about snapshots."]);
  expect(result).toEqual({
    draft: "Snapshots make continuation explicit.",
    failure: null,
    // The APPROVE was delivered to a second runtime, rehydrated from the JSON
    // snapshot — not to the one that produced the draft.
    resumedFromSnapshot: true,
  });
});

test("a turn returns once nothing is in flight, with a JSON blob to store", async () => {
  const turn = await handleTurn(
    { input: { topic: "snapshots" } },
    { generateText: async () => ({ result: "a draft" }) },
  );

  expect(turn.status).toBe("paused");
  if (turn.status !== "paused") throw new Error("expected a pause");
  const stored = JSON.parse(turn.stored) as { value: unknown; context: { draft: string } };
  expect(stored.value).toBe("reviewing");
  expect(stored.context.draft).toBe("a draft");
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
