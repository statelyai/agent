import { expect, test } from "vitest";
import { getInteraction, runAgent } from "@statelyai/agent";
import { MAX_REJECTIONS, humanInTheLoopMachine, runHumanInTheLoopExample } from "./index.js";

/** Canned draft; the real model is only used on direct run. */
const generateText = async ({ prompt }: { prompt?: string }) => ({
  output: `Announcement: ${prompt ?? ""}`,
});

test("drafts, rejects once with feedback, and publishes across two JSON round-trips", async () => {
  const result = await runHumanInTheLoopExample({ topic: "release notes", generateText });

  expect(result.draft).toBe("Announcement: Write a short announcement about: release notes");
  // The interaction came from the machine's own meta, filtered to accepted events.
  expect(result.interactionLabel).toContain("Approve the draft");
  expect(result.legalEvents).toEqual(["APPROVE", "REJECT"]);
  // The rejection's text reached the next prompt, so the redraft differs.
  expect(result.publishedDraft).toContain("Revision requested: Mention the rollback plan.");
  expect(result.drafts).toBe(2);
  expect(result.published).toBe(true);
});

test("the rejection budget ends the run in `abandoned` instead of looping forever", async () => {
  let snapshot = await runAgent(humanInTheLoopMachine, {
    input: { topic: "release notes" },
    executors: { generateText },
  });

  // One more REJECT than the budget allows.
  for (let rejection = 0; rejection <= MAX_REJECTIONS; rejection++) {
    if (snapshot.status !== "idle") break;
    // Every pause renders the same two choices; the budget is enforced by the
    // transition's outcome, not by hiding the button.
    expect(getInteraction(snapshot.snapshot)?.events.map(({ type }) => type)).toEqual([
      "APPROVE",
      "REJECT",
    ]);
    snapshot = await runAgent(humanInTheLoopMachine, {
      snapshot: snapshot.persist(),
      event: { type: "REJECT", text: "Try again." },
      executors: { generateText },
    });
  }

  expect(snapshot.status).toBe("done");
  if (snapshot.status !== "done") return;
  expect(snapshot.output.published).toBe(false);
  expect(snapshot.output.draft).toContain("Revision requested: Try again.");
});
