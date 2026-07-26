import { expect, test } from "vitest";
import { reviewToolCallsMachine, runReviewToolCallsExample } from "./index.js";

// Mock the model: return scripted proposals in call order, one per `proposeRefund`
// invocation. Also records the `prompt` of each call so the redo test can assert
// the reviewer's feedback was threaded into the second proposal. The `sendRefund`
// actor runs REAL — only the model call is mocked.
function scriptedGenerateText(script: unknown[]) {
  const prompts: string[] = [];
  let i = 0;
  const generateText = async (request: { model: string; prompt?: string }) => {
    prompts.push(request.prompt ?? "");
    const output = script[i] ?? script[script.length - 1];
    i++;
    return { output };
  };
  return { generateText, prompts };
}

const proposal = { orderId: "ORD-42", amountCents: 2000, reason: "double charge" };

test("APPROVE executes the proposal unchanged", async () => {
  const { generateText } = scriptedGenerateText([proposal]);
  const result = await runReviewToolCallsExample({
    events: [{ type: "APPROVE" }],
    generateText,
  });

  expect(result.executed).toBe(true);
  expect(result.edited).toBe(false);
  expect(result.call).toEqual(proposal);
  expect(result.proposals).toEqual([proposal]);
  expect(result.legalEvents.sort()).toEqual(["APPROVE", "EDIT", "REJECT"]);
  expect(result.interactionLabel).toContain("Review the proposed refund");
});

test("EDIT executes merged args and marks edited (across a snapshot round-trip)", async () => {
  const { generateText } = scriptedGenerateText([proposal]);
  const result = await runReviewToolCallsExample({
    // Partial override: change the amount, keep orderId + reason.
    events: [{ type: "EDIT", override: { amountCents: 500 } }],
    generateText,
  });

  expect(result.executed).toBe(true);
  expect(result.edited).toBe(true);
  expect(result.call).toEqual({ orderId: "ORD-42", amountCents: 500, reason: "double charge" });
});

test("REJECT feeds feedback into a second proposal; a second REJECT ends without executing", async () => {
  const firstProposal = { orderId: "ORD-42", amountCents: 5000, reason: "too high" };
  const secondProposal = { orderId: "ORD-42", amountCents: 2000, reason: "corrected" };
  const { generateText, prompts } = scriptedGenerateText([firstProposal, secondProposal]);

  const result = await runReviewToolCallsExample({
    events: [
      { type: "REJECT", feedback: "Refund only the duplicate charge, not the full amount." },
      { type: "REJECT", feedback: "Still wrong, cancel this." },
    ],
    generateText,
  });

  // Nothing ran; the run ended in the terminal rejected state.
  expect(result.executed).toBe(false);
  expect(result.call).toBeNull();
  expect(result.edited).toBe(false);
  // Two proposals were reviewed (original + one bounded revision).
  expect(result.proposals).toEqual([firstProposal, secondProposal]);
  // The reviewer's feedback reached the second proposal request.
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain("Refund only the duplicate charge");
});

test("machine exports a runnable definition", () => {
  expect(reviewToolCallsMachine.id).toBe("review-tool-calls");
});
