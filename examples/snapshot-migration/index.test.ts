import { expect, test } from "vitest";
import { createAgentRuntime, runToQuiescence } from "@statelyai/agent";
import {
  formatMoney,
  migrateOrderSnapshot,
  orderApprovalMachine,
  orderApprovalMachineV1,
  pauseOnV1,
  persistSnapshot,
  runSnapshotMigrationExample,
  V1,
  V2,
} from "./index.js";

async function persistedV1Snapshot(orderId = "ORD-1", total = 812.5) {
  const paused = await runToQuiescence(createAgentRuntime(orderApprovalMachineV1), {
    input: { orderId, total },
  });
  if (paused.status !== "idle") throw new Error(`Expected idle, got '${paused.status}'.`);
  return persistSnapshot(paused.persist());
}

test("XState's persisted snapshot carries the machine version", async () => {
  const persisted = await pauseOnV1({ orderId: "ORD-1", total: 812.5 });
  expect((persisted as { version?: string }).version).toBe(V1);
  expect((persisted as { value?: unknown }).value).toBe("reviewing");
});

test("the machine-owned migrate callback resumes v1 state on v2", async () => {
  const result = await runSnapshotMigrationExample({ orderId: "ORD-4417", total: 812.5 });
  expect(result.output).toEqual({
    orderId: "ORD-4417",
    approved: true,
    amount: "$812.50",
    riskLevel: "high",
  });
  // The result reads as an explanation; the raw persisted snapshot stays out of it.
  expect(Object.keys(result).sort()).toEqual(["output", "summary"]);
  expect(JSON.stringify(result)).not.toContain('"version"');
  expect(result.summary).toContain(`on v${V1}, waiting in \`reviewing\``);
  expect(result.summary).toContain(
    `ran the v${V2} machine's \`migrate\`: \`reviewing\` → \`awaitingApproval\`, ` +
      "total 812.5 → 81250 cents ($812.50), risk high.",
  );
  expect(result.summary).toContain("order ORD-4417 approved.");
});

test("the reviewer sees money, not raw cents", async () => {
  const paused = await runToQuiescence(createAgentRuntime(orderApprovalMachine), {
    input: { orderId: "ORD-2", amountCents: 2500, currency: "USD" },
  });
  if (paused.status !== "idle") throw new Error(`Expected idle, got '${paused.status}'.`);
  const description = paused.snapshot.nodes.at(-1)!.description!;
  const shown = description.replace(/\{(\w+)\}/g, (_, key: string) =>
    String((paused.snapshot.context as Record<string, unknown>)[key]),
  );
  expect(shown).toBe("Order ORD-2 ($25.00, low risk) is waiting for a reviewer.");
  expect(formatMoney(81250, "USD")).toBe("$812.50");
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
    amountDisplay: "$12.34",
    riskLevel: "low",
  });
});

test("migration rejects totals that cannot be represented as safe integer cents", async () => {
  const persisted = await persistedV1Snapshot("ORD-HUGE", 100_000_000_000_000);
  expect(() => migrateOrderSnapshot(persisted, V1)).toThrow(/safe integer cents/);
});

test("a current snapshot resumes without migration", async () => {
  const paused = await runToQuiescence(createAgentRuntime(orderApprovalMachine), {
    input: { orderId: "ORD-2", amountCents: 2500 },
  });
  if (paused.status !== "idle") throw new Error(`Expected idle, got '${paused.status}'.`);
  const resumed = await runToQuiescence(createAgentRuntime(orderApprovalMachine), {
    snapshot: persistSnapshot(paused.persist()),
    event: { type: "REJECT", reason: "duplicate order" },
  });
  expect(resumed.status).toBe("done");
  if (resumed.status !== "done") return;
  // People read the amount formatted, not as raw cents.
  expect(resumed.output).toEqual({
    orderId: "ORD-2",
    approved: false,
    amount: "$25.00",
    riskLevel: "low",
  });
});
