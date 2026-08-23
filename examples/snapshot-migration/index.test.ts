import { expect, test } from "vitest";
import { assertJsonSerializable, runAgent } from "@statelyai/agent";
import { AgentSnapshotVersionMismatchError } from "@statelyai/agent";
import {
  migrateOrderSnapshot,
  persistSnapshot,
  orderApprovalMachine,
  orderApprovalMachineV1,
  runSnapshotMigrationExample,
  V1,
  V2,
} from "./index.js";

/** A v1 run paused at its idle gate, persisted as plain JSON. */
async function persistedV1Snapshot(orderId = "ORD-1", total = 812.5) {
  const paused = await runAgent(orderApprovalMachineV1, {
    input: { orderId, total },
  });
  if (paused.status !== "idle") {
    throw new Error(`Expected idle, got '${paused.status}'.`);
  }
  return persistSnapshot(paused.snapshot);
}

test("a v1 idle snapshot is stamped with its machine version and round-trips as JSON", async () => {
  const persisted = await persistedV1Snapshot();
  expect((persisted as { value?: unknown }).value).toBe("reviewing");
  expect((persisted as { agentMeta?: { version?: string } }).agentMeta?.version).toBe(V1);
  // Nothing in the persisted snapshot is a value JSON would drop or coerce.
  expect(() => assertJsonSerializable(persisted, "snapshot")).not.toThrow();
  expect(persistSnapshot(persisted)).toEqual(persisted);
});

test("resuming the v1 snapshot on v2 throws AgentSnapshotVersionMismatchError with from/to", async () => {
  const persisted = await persistedV1Snapshot();
  let caught: unknown;
  try {
    await runAgent(orderApprovalMachine, {
      snapshot: persisted as never,
      event: { type: "APPROVE" },
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AgentSnapshotVersionMismatchError);
  const mismatch = caught as AgentSnapshotVersionMismatchError;
  expect(mismatch.from).toBe(V1);
  expect(mismatch.to).toBe(V2);
  expect(mismatch.machineId).toBe("order-approval");
});

test("migrateSnapshot resumes the migrated snapshot and completes with the v2 context", async () => {
  const result = await runSnapshotMigrationExample({ orderId: "ORD-4417", total: 812.5 });
  expect(result.stampedVersion).toBe(V1);
  expect(result.mismatch).toBeInstanceOf(AgentSnapshotVersionMismatchError);
  expect(result.migrationInfo).toEqual({ from: V1, to: V2 });
  expect(result.output).toEqual({
    orderId: "ORD-4417",
    approved: true,
    // 812.50 dollars became integer cents, and the new risk rule was applied.
    amountCents: 81250,
    currency: "USD",
    riskLevel: "high",
  });
});

test("the migration is a pure function of the old snapshot", async () => {
  const persisted = await persistedV1Snapshot("ORD-9", 12.34);
  const before = persistSnapshot(persisted);
  const migrated = migrateOrderSnapshot(persisted as never) as unknown as {
    value: unknown;
    context: Record<string, unknown>;
  };
  expect(persisted).toEqual(before); // input untouched
  expect(migrated.value).toBe("awaitingApproval");
  expect(migrated.context).toEqual({
    orderId: "ORD-9",
    amountCents: 1234,
    currency: "USD",
    riskLevel: "low",
    decision: "pending",
  });
});

test("opting out with 'ignore' does not protect you — the stale snapshot fails elsewhere", async () => {
  const persisted = await persistedV1Snapshot();
  let caught: unknown;
  try {
    await runAgent(orderApprovalMachine, {
      snapshot: persisted as never,
      event: { type: "APPROVE" },
      onVersionMismatch: "ignore",
    });
  } catch (error) {
    caught = error;
  }
  // It still fails, just later and with an error that names nothing useful —
  // which is the argument for the default 'throw'.
  expect(caught).toBeInstanceOf(Error);
  expect(caught).not.toBeInstanceOf(AgentSnapshotVersionMismatchError);
});

test("a v2 snapshot resumes on v2 without any migration", async () => {
  const paused = await runAgent(orderApprovalMachine, {
    input: { orderId: "ORD-2", amountCents: 2500 },
  });
  if (paused.status !== "idle") {
    throw new Error(`Expected idle, got '${paused.status}'.`);
  }
  const resumed = await runAgent(orderApprovalMachine, {
    snapshot: persistSnapshot(paused.snapshot),
    event: { type: "REJECT", reason: "duplicate order" },
  });
  expect(resumed.status).toBe("done");
  if (resumed.status !== "done") return;
  expect(resumed.output).toEqual({
    orderId: "ORD-2",
    approved: false,
    amountCents: 2500,
    currency: "USD",
    riskLevel: "low",
  });
});
