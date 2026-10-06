import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { createMockModelExecutors } from "../mock-model.js";
import { MAX_REVISIONS, runXstateV5JsonExample } from "./index.js";

test("the JSON is plain v5 config: string targets, named actions and guards, no model", () => {
  const json = readFileSync(new URL("./machine.json", import.meta.url), "utf8");
  const config = JSON.parse(json);
  expect(config.states.drafting.invoke).toMatchObject({ src: "draftReply", onError: "failed" });
  expect(config.states.reviewing.on.APPROVE).toBe("sent");
  expect(config.states.reviewing.on.REVISE[0].guard).toBe("canRevise");
  expect(json).not.toMatch(/model|prompt|@code|@expr/);
});

test("drafts from the submitted ticket and sends on approval", async () => {
  const executors = createMockModelExecutors({
    text: { draftReply: "Sorry about the double charge — refunded." },
  });
  const result = await runXstateV5JsonExample(executors, {
    ticket: "Charged twice in March.",
    reviews: [{ type: "APPROVE" }],
  });

  expect(result).toEqual({
    outcome: "sent",
    draft: "Sorry about the double charge — refunded.",
    revisions: 0,
  });
  // The invoke input came from context through `inputs.draftReply`.
  expect(executors.calls[0]!.input).toEqual({ ticket: "Charged twice in March.", feedback: null });
});

test("feedback redrafts with the reviewer's words, and the guard caps revisions", async () => {
  const executors = createMockModelExecutors({
    text: { draftReply: ["first", "second", "third"] },
  });
  const result = await runXstateV5JsonExample(executors, {
    reviews: [
      { type: "REVISE", text: "warmer" },
      { type: "REVISE", text: "shorter" },
      { type: "REVISE", text: "again" },
    ],
  });

  expect(result).toEqual({ outcome: "gaveUp", draft: "third", revisions: MAX_REVISIONS });
  expect(executors.calls.map((call) => call.input)).toEqual([
    { ticket: expect.any(String), feedback: null },
    { ticket: expect.any(String), feedback: "warmer" },
    { ticket: expect.any(String), feedback: "shorter" },
  ]);
});

test("a failed request lands in the JSON's `failed` state", async () => {
  const result = await runXstateV5JsonExample(
    createMockModelExecutors({
      text: {
        draftReply: () => {
          throw new Error("model unavailable");
        },
      },
    }),
  );
  expect(result.outcome).toBe("failed");
});
