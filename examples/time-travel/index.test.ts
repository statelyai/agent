import { expect, test } from "vitest";
import { runTimeTravelExample, timeTravelMachine } from "./index.js";

// Deterministic mock: the draft depends only on whether a revision note is
// present in the prompt. APPROVE takes no model call, so the forked branch (which
// approves the ORIGINAL draft) reuses the initial-draft text with no new request.
const mockGenerateText = async ({ prompt }: { prompt?: string }) => ({
  output: prompt?.includes("Revision requested")
    ? "A revised answer — like a mailbox that holds messages until you read them."
    : "An initial answer about actors.",
});

test("fork from an earlier checkpoint diverges; the main branch is unchanged", async () => {
  const result = await runTimeTravelExample({ generateText: mockGenerateText });

  // Main branch approved the REVISED draft (one revision applied).
  expect(result.mainAnswer).toContain("revised answer");
  expect(result.mainRevisions).toBe(1);

  // Forked branch rewound to checkpoint #1 and approved the ORIGINAL draft
  // (zero revisions) — a divergent final answer.
  expect(result.forkedAnswer).toBe("An initial answer about actors.");
  expect(result.forkedRevisions).toBe(0);
  expect(result.rewoundFrom).toBe("draft-1 · awaiting review");

  // The two branches genuinely diverge.
  expect(result.forkedAnswer).not.toBe(result.mainAnswer);

  // The fork did not perturb the main branch's checkpoints or outcome.
  expect(result.checkpointLabels).toHaveLength(3);
  expect(result.mainAnswer).toContain("revised answer");
});

test("checkpoint history has the expected labels after the full flow", async () => {
  const result = await runTimeTravelExample({ generateText: mockGenerateText });

  expect(result.checkpointLabels).toEqual([
    "draft-1 · awaiting review",
    "draft-2 · awaiting review",
    "draft-2 · approved",
  ]);
});

test("machine exports a runnable definition", () => {
  expect(timeTravelMachine.id).toBe("time-travel");
});
