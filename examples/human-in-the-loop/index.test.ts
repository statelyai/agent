import { expect, test } from "vitest";
import { runHumanInTheLoopExample } from "./index.js";

test("drafts, settles idle for review, survives snapshot round-trip, resumes on APPROVE", async () => {
  // Mock model: canned draft. The real model is only used on direct run.
  const generateText = async ({ prompt }: { prompt?: string }) => ({
    output: `Announcement: ${prompt ?? ""}`,
  });

  const result = await runHumanInTheLoopExample({
    topic: "release notes",
    generateText,
  });

  expect(result.draft).toBe("Announcement: Write a short announcement about: release notes");
  // Typed meta.interaction surfaced from the idle state.
  expect(result.interactionLabel).toContain("Review the draft");
  expect(result.legalEvents).toEqual(["APPROVE", "REJECT"]);
  // Resumed second runAgent call published.
  expect(result.published).toBe(true);
  expect(result.publishedDraft).toBe(result.draft);
});
