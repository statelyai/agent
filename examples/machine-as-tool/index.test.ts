import { expect, test } from "vitest";
import { createAsyncLogic } from "xstate";
import { AgentIllegalResumeEventError, type RunAgentOptions } from "@statelyai/agent";
import { refundMachine, resolveInteractionLabel, resumeTool, startTool } from "./index.js";

// Mock executors: validator returns valid, processRefund is a no-op side effect.
const executors: RunAgentOptions<typeof refundMachine> = {
  executors: { generateText: async () => ({ output: { valid: true } }) },
  actors: {
    processRefund: createAsyncLogic({ run: async () => ({ ok: true }) }),
  },
};

test("happy path: start → idle handle with interaction → approve → done", async () => {
  const started = await startTool({ amount: 42, orderId: "ord-1" }, executors);

  expect(started.status).toBe("pending");
  if (started.status !== "pending") return;
  expect(started.interaction?.label).toContain("Approve the ${amount} refund");
  expect(Object.keys(started.interaction?.events ?? {})).toEqual(["APPROVE", "REJECT"]);
  // Free text must land on REJECT, never on the approve path.
  expect(started.interaction?.textEvent).toBe("REJECT");
  expect(started.interaction?.events?.APPROVE?.style).toBe("primary");
  expect(started.interaction?.events?.REJECT?.style).toBe("danger");
  // Handle is a JSON string — proves the snapshot round-trips through a store.
  expect(typeof started.handle).toBe("string");

  const done = await resumeTool(started.handle, { type: "APPROVE" }, executors);
  expect(done.status).toBe("done");
  if (done.status !== "done") return;
  expect(done.output).toEqual({ refunded: true, reason: null });
});

test("resolved interaction copy never leaves a space before punctuation", async () => {
  // A blank order id resolves to "" — a label that punctuates a placeholder
  // directly (`{orderId},`) would render "on order , or type…".
  for (const orderId of ["ORD-4471", ""]) {
    const started = await startTool({ amount: 129.99, orderId }, executors);
    expect(started.status).toBe("pending");
    if (started.status !== "pending") return;

    const context = JSON.parse(started.handle).context as Record<string, unknown>;
    const labels = [
      started.interaction?.label ?? "",
      ...Object.values(started.interaction?.events ?? {}).map((button) => button.label ?? ""),
    ].map((label) => resolveInteractionLabel(label, context));

    for (const label of labels) {
      expect(label).not.toMatch(/\s[,.;:!?)]/);
      expect(label).not.toMatch(/ {2}/);
    }
  }

  const filled = await startTool({ amount: 129.99, orderId: "ORD-4471" }, executors);
  if (filled.status !== "pending") throw new Error("expected pending");
  const context = JSON.parse(filled.handle).context as Record<string, unknown>;
  expect(resolveInteractionLabel(filled.interaction?.label ?? "", context)).toBe(
    "Approve the $129.99 refund on order ORD-4471 or type a reason to reject it.",
  );
  expect(resolveInteractionLabel(filled.interaction?.events?.APPROVE?.label ?? "", context)).toBe(
    "Approve refund of $129.99",
  );
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

test("illegal event is rejected when resuming (runAgent throws AgentIllegalResumeEventError)", async () => {
  const started = await startTool({ amount: 5, orderId: "ord-3" }, executors);
  expect(started.status).toBe("pending");
  if (started.status !== "pending") return;

  // PROMPT_SUBMITTED is not a legal event in awaitingApproval — resumeTool's
  // runAgent throws AgentIllegalResumeEventError before delivering it.
  await expect(
    resumeTool(started.handle, { type: "PROMPT_SUBMITTED" } as never, executors),
  ).rejects.toBeInstanceOf(AgentIllegalResumeEventError);

  // The legal events (APPROVE / REJECT) resume without throwing.
  const done = await resumeTool(started.handle, { type: "APPROVE" }, executors);
  expect(done.status).toBe("done");
});
