import { expect, test } from "vitest";
import type { ModelMessage } from "ai";
import type { AgentTextRequest, AgentTool } from "@statelyai/agent";
import {
  reviewToolCallsMachine,
  runReviewToolCallsExample,
  runToolCallingExample,
  type RefundCall,
} from "./index.js";

// Mock the model: return scripted proposals in call order, one per `proposeRefund`
// invocation. Also records the `prompt` of each call so the redo test can assert
// the reviewer's feedback was threaded into the second proposal. The `sendRefund`
// actor runs REAL — only the model call is mocked.
function scriptedGenerateText(script: unknown[]) {
  const prompts: string[] = [];
  let i = 0;
  const generateText = async (request: { name?: string; prompt?: string }) => {
    if (request.name !== "proposeRefund") {
      throw new Error(`unexpected request '${request.name}'`);
    }
    prompts.push(request.prompt ?? "");
    const output = script[i];
    if (output === undefined) throw new Error("the proposal script ran dry");
    i++;
    return { output };
  };
  return { generateText, prompts };
}

const proposal = { orderId: "ORD-42", amountCents: 2000, reason: "double charge" };

test("APPROVE executes the proposal unchanged, through the caller's own side effect", async () => {
  const { generateText } = scriptedGenerateText([proposal]);
  // The ledger belongs to the test, not to the module.
  const sent: RefundCall[] = [];
  const result = await runReviewToolCallsExample({
    events: [{ type: "APPROVE" }],
    generateText,
    sendRefund: async (call) => {
      sent.push(call);
      return call;
    },
  });

  expect(sent).toEqual([proposal]);
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

test("running out of resume events is an error, not a replay of the last one", async () => {
  const { generateText } = scriptedGenerateText([proposal, proposal]);

  await expect(
    runReviewToolCallsExample({
      // One REJECT triggers a redo, so the machine settles idle twice — and
      // only one event was supplied.
      events: [{ type: "REJECT", feedback: "Too high." }],
      generateText,
    }),
  ).rejects.toThrow(/only 1 resume event/);
});

test("a failing proposal request ends in `failed` without executing anything", async () => {
  const sent: RefundCall[] = [];
  const result = await runReviewToolCallsExample({
    generateText: async () => {
      throw new Error("assistant offline");
    },
    sendRefund: async (call) => {
      sent.push(call);
      return call;
    },
  });

  expect(result.executed).toBe(false);
  expect(result.call).toBeNull();
  expect(result.failure).toMatch(/^proposeRefund failed: /);
  expect(sent).toEqual([]);
});

test("machine exports a runnable definition", () => {
  expect(reviewToolCallsMachine.id).toBe("review-tool-calls");
});

// --- Variant 2: SDK-owned tool loop -----------------------------------------

function executeTool(tool: AgentTool | undefined, input: unknown) {
  return typeof tool === "function" ? tool(input) : tool?.execute?.(input);
}

/** The last number the calculator returned in this transcript, if any. */
function lastToolResult(messages: ModelMessage[]): number | null {
  for (const message of [...messages].reverse()) {
    if (message.role !== "tool" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      const output = (part as { output?: { value?: { value?: number } } }).output;
      if (typeof output?.value?.value === "number") return output.value.value;
    }
  }
  return null;
}

/**
 * A stand-in for the AI SDK's own tool loop: it reads the LIVE transcript, runs
 * the real tool the request carries, and returns the messages that loop
 * produced. Nothing is canned — a follow-up referring to "that" can only be
 * answered from the tool results still in the transcript.
 */
async function toolLoop(request: AgentTextRequest) {
  const messages = (request.messages ?? []) as ModelMessage[];
  const question = String(messages.at(-1)?.content ?? "");

  const direct = /(\d+)\s*(times|plus)\s*(\d+)/.exec(question);
  const followUp = /that\s*(times|plus)\s*(\d+)/.exec(question);
  let operation: "add" | "multiply";
  let a: number;
  let b: number;
  if (direct) {
    operation = direct[2] === "times" ? "multiply" : "add";
    a = Number(direct[1]);
    b = Number(direct[3]);
  } else if (followUp) {
    const previous = lastToolResult(messages);
    if (previous === null) throw new Error("no earlier result to refer to");
    operation = followUp[1] === "times" ? "multiply" : "add";
    a = previous;
    b = Number(followUp[2]);
  } else {
    throw new Error(`cannot parse '${question}'`);
  }

  const result = (await executeTool(request.tools?.calculate, { operation, a, b })) as {
    value: number;
  };
  const text = `${a} ${operation === "multiply" ? "times" : "plus"} ${b} is ${result.value}.`;
  const responseMessages: ModelMessage[] = [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: `call-${messages.length}`,
          toolName: "calculate",
          input: { operation, a, b },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: `call-${messages.length}`,
          toolName: "calculate",
          output: { type: "json", value: { value: result.value } },
        },
      ],
    },
    { role: "assistant", content: text },
  ];
  return { output: text, messages: responseMessages };
}

test("the host tool loop runs the real tool and the machine appends its messages", async () => {
  const seen: number[] = [];
  const output = await runToolCallingExample("What is 6 times 7?", {
    executors: {
      generateText: async (request) => {
        expect(request.maxSteps).toBe(5);
        seen.push((request.messages ?? []).length);
        return toolLoop(request);
      },
    },
  });

  expect(output.status).toBe("answered");
  expect(output.answers).toEqual(["6 times 7 is 42."]);
  // One user message in, three response messages appended.
  expect(seen).toEqual([1]);
  expect(output.messages).toHaveLength(4);
});

test("a follow-up is answerable only because the transcript is retained", async () => {
  const transcriptSizes: number[] = [];
  const output = await runToolCallingExample("What is 6 times 7?", {
    followUps: ["And what is that plus 8?"],
    executors: {
      generateText: async (request) => {
        transcriptSizes.push((request.messages ?? []).length);
        return toolLoop(request);
      },
    },
  });

  // Turn 2 resolved "that" from the tool result retained from turn 1.
  expect(output.answers).toEqual(["6 times 7 is 42.", "42 plus 8 is 50."]);
  // Turn 1 saw 1 message; turn 2 saw those plus 3 response messages plus the
  // follow-up question.
  expect(transcriptSizes).toEqual([1, 5]);
  expect(output.messages).toHaveLength(8);
});

test("a failing request ends in `failed` with the transcript so far", async () => {
  const output = await runToolCallingExample("What is 6 times 7?", {
    executors: {
      generateText: async () => {
        throw new Error("model unavailable");
      },
    },
  });

  expect(output.status).toBe("failed");
  expect(output.answer).toBe(null);
  // The question the human asked is still on the transcript.
  expect(output.messages).toEqual([{ role: "user", content: "What is 6 times 7?" }]);
});
