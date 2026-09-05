import { expect, test } from "vitest";
import { runAgent } from "@statelyai/agent";
import {
  migrateOrderSnapshot,
  orderApprovalMachine,
  orderApprovalMachineV1,
  persistSnapshot,
  runSnapshotMigrationExample,
  V1,
  V2,
} from "./index.js";

async function persistedV1Snapshot(orderId = "ORD-1", total = 812.5) {
  const paused = await runAgent(orderApprovalMachineV1, { input: { orderId, total } });
  if (paused.status !== "idle") throw new Error(`Expected idle, got '${paused.status}'.`);
  return persistSnapshot(paused.persist());
}

test("XState's persisted snapshot carries the machine version", async () => {
  const persisted = await persistedV1Snapshot();
  expect((persisted as { version?: string }).version).toBe(V1);
  expect((persisted as { value?: unknown }).value).toBe("reviewing");
});

test("the machine-owned migrate callback resumes v1 state on v2", async () => {
  const result = await runSnapshotMigrationExample({ orderId: "ORD-4417", total: 812.5 });
  expect((result.persisted as { version?: string }).version).toBe(V1);
  expect(result.output).toEqual({
    orderId: "ORD-4417",
    approved: true,
    amountCents: 81250,
    currency: "USD",
    riskLevel: "high",
  });
});

test("migration is pure and writes the current version", async () => {
  const persisted = await persistedV1Snapshot("ORD-9", 12.34);
  const before = persistSnapshot(persisted);
  const migrated = migrateOrderSnapshot(persisted, V1) as typeof persisted & {
    value: unknown;
    context: Record<string, unknown>;
    version: string;
  };
  expect(persisted).toEqual(before);
  expect(migrated.version).toBe(V2);
  expect(migrated.value).toBe("awaitingApproval");
  expect(migrated.context).toEqual({
    orderId: "ORD-9",
    amountCents: 1234,
    currency: "USD",
    riskLevel: "low",
    decision: "pending",
  });
});

test("migration rejects totals that cannot be represented as safe integer cents", async () => {
  const persisted = await persistedV1Snapshot("ORD-HUGE", 100_000_000_000_000);
  expect(() => migrateOrderSnapshot(persisted, V1)).toThrow(/safe integer cents/);
});

test("a current snapshot resumes without migration", async () => {
  const paused = await runAgent(orderApprovalMachine, {
    input: { orderId: "ORD-2", amountCents: 2500 },
  });
  if (paused.status !== "idle") throw new Error(`Expected idle, got '${paused.status}'.`);
  const resumed = await runAgent(orderApprovalMachine, {
    snapshot: persistSnapshot(paused.persist()),
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
