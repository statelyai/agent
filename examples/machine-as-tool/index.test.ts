import { expect, test } from "vitest";
import { createAsyncLogic } from "xstate";
import { IllegalResumeEventError, type RunAgentOptions } from "@statelyai/agent";
import { refundMachine, resumeTool, startTool } from "./index.js";

// Mock executors: validator returns valid, processRefund is a no-op side effect.
const executors: RunAgentOptions<typeof refundMachine> = {
  executors: { generateText: async () => ({ output: { valid: true } }) },
  actorSources: {
    processRefund: createAsyncLogic({ run: async () => ({ ok: true }) }),
  },
};

test("happy path: start → idle handle with interaction → approve → done", async () => {
  const started = await startTool({ amount: 42, orderId: "ord-1" }, executors);

  expect(started.status).toBe("pending");
  if (started.status !== "pending") return;
  expect(started.interaction?.label).toBe("Approve this refund?");
  expect(started.interaction?.choices.map((c) => c.eventType)).toEqual(["APPROVE", "REJECT"]);
  // Handle is a JSON string — proves the snapshot round-trips through a store.
  expect(typeof started.handle).toBe("string");

  const done = await resumeTool(started.handle, { type: "APPROVE" }, executors);
  expect(done.status).toBe("done");
  if (done.status !== "done") return;
  expect(done.output).toEqual({ refunded: true, reason: null });
});

test("reject path: resume with REJECT ends with refunded:false", async () => {
  const started = await startTool({ amount: 9, orderId: "ord-2" }, executors);
  expect(started.status).toBe("pending");
  if (started.status !== "pending") return;

  const done = await resumeTool(started.handle, { type: "REJECT", reason: "duplicate" }, executors);
  expect(done.status).toBe("done");
  if (done.status !== "done") return;
  expect(done.output).toEqual({ refunded: false, reason: "duplicate" });
});

test("illegal event is rejected when resuming (runAgent throws IllegalResumeEventError)", async () => {
  const started = await startTool({ amount: 5, orderId: "ord-3" }, executors);
  expect(started.status).toBe("pending");
  if (started.status !== "pending") return;

  // PROMPT_SUBMITTED is not a legal event in awaitingApproval — resumeTool's
  // runAgent throws IllegalResumeEventError before delivering it.
  await expect(
    resumeTool(started.handle, { type: "PROMPT_SUBMITTED" } as never, executors),
  ).rejects.toBeInstanceOf(IllegalResumeEventError);

  // The legal events (APPROVE / REJECT) resume without throwing.
  const done = await resumeTool(started.handle, { type: "APPROVE" }, executors);
  expect(done.status).toBe("done");
});
