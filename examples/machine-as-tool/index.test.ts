import { expect, test } from "vitest";
import { createAsyncLogic } from "xstate";
import {
  AUTO_APPROVAL_LIMIT,
  resumeTool,
  runMachineAsToolExample,
  startTool,
  type RefundRunOptions,
} from "./index.js";

// Mock executors: the policy check applies the same limit the machine's
// prompt states (routed on the request name, never on prompt text), and
// processRefund is a no-op side effect.
const runOptions: RefundRunOptions = {
  executors: {
    generateText: async (request) => {
      if (request.name !== "validateRefund") {
        throw new Error(`Unexpected request '${request.name}'.`);
      }
      const { amount } = request.input as { amount: number };
      return { output: { valid: amount <= AUTO_APPROVAL_LIMIT } };
    },
  },
  actors: {
    processRefund: createAsyncLogic({ run: async () => ({ ok: true }) }),
  },
};

test("under the limit: the policy check auto-approves, no human pause", async () => {
  const started = await startTool({ amount: 129.99, orderId: "ORD-4471" }, runOptions);

  expect(started.status).toBe("done");
  if (started.status !== "done") return;
  expect(started.output).toEqual({ refunded: true, reason: null });
});

test("over the limit: start → idle handle with interaction → approve → done", async () => {
  const started = await startTool({ amount: 780, orderId: "ORD-9002" }, runOptions);

  expect(started.status).toBe("pending");
  if (started.status !== "pending") return;
  // `getInteraction` resolved `{amount}` / `{orderId}` against the context.
  expect(started.interaction?.label).toBe(
    "Approve the $780 refund on order ORD-9002 or type a reason to reject it.",
  );
  expect(started.interaction?.events.map(({ type }) => type)).toEqual(["APPROVE", "REJECT"]);
  // Free text must land on REJECT, never on the approve path.
  expect(started.interaction?.textEvent).toBe("REJECT");
  expect(started.interaction?.events).toEqual([
    { type: "APPROVE", label: "Approve refund of $780", style: "primary" },
    { type: "REJECT", label: "Reject refund", style: "danger" },
  ]);
  // Handle is a JSON string — proves the snapshot round-trips through a store.
  expect(typeof started.handle).toBe("string");

  const done = await resumeTool(started.handle, { type: "APPROVE" }, runOptions);
  expect(done.status).toBe("done");
  if (done.status !== "done") return;
  expect(done.output).toEqual({ refunded: true, reason: null });
});

test("resolved interaction copy never leaves a space before punctuation", async () => {
  // A blank order id resolves to "" — a label that punctuates a placeholder
  // directly (`{orderId},`) would render "on order , or type…".
  for (const orderId of ["ORD-9002", ""]) {
    const started = await startTool({ amount: 780, orderId }, runOptions);
    expect(started.status).toBe("pending");
    if (started.status !== "pending") return;

    const labels = [
      started.interaction?.label ?? "",
      ...(started.interaction?.events ?? []).map((choice) => choice.label),
    ];
    for (const label of labels) {
      expect(label).not.toMatch(/\s[,.;:!?)]/);
      expect(label).not.toMatch(/ {2}/);
    }
  }
});

test("reject path: resume with REJECT ends with refunded:false", async () => {
  const started = await startTool({ amount: 900, orderId: "ord-2" }, runOptions);
  expect(started.status).toBe("pending");
  if (started.status !== "pending") return;

  const done = await resumeTool(
    started.handle,
    { type: "REJECT", reason: "duplicate" },
    runOptions,
  );
  expect(done.status).toBe("done");
  if (done.status !== "done") return;
  expect(done.output).toEqual({ refunded: false, reason: "duplicate" });
});

test("an event the state does not handle is ignored, and the harness says so", async () => {
  const started = await startTool({ amount: 780, orderId: "ord-3" }, runOptions);
  expect(started.status).toBe("pending");
  if (started.status !== "pending") return;

  // `awaitingApproval` has no transition for PROMPT_SUBMITTED, so the machine
  // ignores it: `runAgent` settles normally with `result.ignored` set, and
  // `resumeTool` turns that into the harness's own error.
  await expect(
    resumeTool(started.handle, { type: "PROMPT_SUBMITTED" } as never, runOptions),
  ).rejects.toThrow(/'PROMPT_SUBMITTED' does not apply/);

  // The events the state does handle (APPROVE / REJECT) resume as before.
  const done = await resumeTool(started.handle, { type: "APPROVE" }, runOptions);
  expect(done.status).toBe("done");
});

test("the handle is the whole run: two paused runs resume in any order, with no host store", async () => {
  // The point of the stateless bridge (vs ../mastra-host's store-keyed handle):
  // nothing about a paused run lives on the host, so handles are independent
  // and order-free. Pass each through an explicit JSON round-trip to stand in
  // for a DB row or queue message.
  const first = await startTool({ amount: 780, orderId: "ORD-A" }, runOptions);
  const second = await startTool({ amount: 900, orderId: "ORD-B" }, runOptions);
  expect(first.status).toBe("pending");
  expect(second.status).toBe("pending");
  if (first.status !== "pending" || second.status !== "pending") return;

  const throughStore = (handle: string) => JSON.stringify(JSON.parse(handle));

  // Resume the SECOND run first — a store-backed host would need per-run state
  // to do this; here each handle carries its own.
  const rejected = await resumeTool(
    throughStore(second.handle),
    { type: "REJECT", reason: "duplicate" },
    runOptions,
  );
  const approved = await resumeTool(throughStore(first.handle), { type: "APPROVE" }, runOptions);

  expect(rejected.status === "done" && rejected.output).toEqual({
    refunded: false,
    reason: "duplicate",
  });
  expect(approved.status === "done" && approved.output).toEqual({
    refunded: true,
    reason: null,
  });
});

test("the exported demo runs the over-limit path end to end", async () => {
  const finished = await runMachineAsToolExample(runOptions);
  expect(finished.status).toBe("done");
});
