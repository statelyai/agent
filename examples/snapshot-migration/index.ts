/** Native XState snapshot versioning and migration through `runAgent`. */
import { z } from "zod";
import type { Snapshot } from "xstate";
import { runAgent, setupAgent } from "@statelyai/agent";

export const V1 = "1.0.0";
export const V2 = "2.0.0";
export const HIGH_RISK_CENTS = 50_000;

export function persistSnapshot<T>(snapshot: T): T {
  return JSON.parse(JSON.stringify(snapshot)) as T;
}

const v1 = setupAgent({
  context: z.object({
    orderId: z.string(),
    total: z.number(),
    decision: z.enum(["pending", "approved", "rejected"]),
  }),
  input: z.object({ orderId: z.string(), total: z.number() }),
  output: z.object({ orderId: z.string(), approved: z.boolean() }),
  events: { APPROVE: z.object({}), REJECT: z.object({ reason: z.string() }) },
  isIdle: (snapshot) => snapshot.hasTag("awaiting-approval"),
});

export const orderApprovalMachineV1 = v1.createMachine({
  id: "order-approval",
  version: V1,
  context: ({ input }) => ({ orderId: input.orderId, total: input.total, decision: "pending" }),
  initial: "reviewing",
  states: {
    reviewing: {
      tags: ["awaiting-approval"],
      on: {
        APPROVE: { target: "settled", context: { decision: "approved" } },
        REJECT: { target: "settled", context: { decision: "rejected" } },
      },
    },
    settled: {
      type: "final",
      output: ({ context }) => ({
        orderId: context.orderId,
        approved: context.decision === "approved",
      }),
    },
  },
});

interface V1Context {
  orderId: string;
  total: number;
  decision: "pending" | "approved" | "rejected";
}

/** XState `migrate` callback: old persisted snapshot in, current snapshot out. */
export function migrateOrderSnapshot(
  snapshot: Snapshot<unknown>,
  fromVersion: string | undefined = V1,
): Snapshot<unknown> {
  if (fromVersion !== V1) return snapshot;
  const old = snapshot as Snapshot<unknown> & { value?: unknown; context?: V1Context };
  if (!old.context) return snapshot;
  const amountCents = Math.round(old.context.total * 100);
  if (!Number.isSafeInteger(amountCents)) {
    throw new RangeError(
      `Cannot migrate order '${old.context.orderId}': total ${old.context.total} cannot be represented as safe integer cents.`,
    );
  }
  return {
    ...old,
    version: V2,
    value: old.value === "reviewing" ? "awaitingApproval" : old.value,
    context: {
      orderId: old.context.orderId,
      amountCents,
      currency: "USD",
      riskLevel: amountCents >= HIGH_RISK_CENTS ? "high" : "low",
      decision: old.context.decision,
    },
  } as unknown as Snapshot<unknown>;
}

const v2 = setupAgent({
  context: z.object({
    orderId: z.string(),
    amountCents: z.number().int(),
    currency: z.string(),
    riskLevel: z.enum(["low", "high"]),
    decision: z.enum(["pending", "approved", "rejected"]),
  }),
  input: z.object({
    orderId: z.string(),
    amountCents: z.number().int(),
    currency: z.string().optional(),
  }),
  output: z.object({
    orderId: z.string(),
    approved: z.boolean(),
    amountCents: z.number().int(),
    currency: z.string(),
    riskLevel: z.enum(["low", "high"]),
  }),
  events: { APPROVE: z.object({}), REJECT: z.object({ reason: z.string() }) },
  isIdle: (snapshot) => snapshot.hasTag("awaiting-approval"),
});

export const orderApprovalMachine = v2.createMachine({
  id: "order-approval",
  version: V2,
  migrate: migrateOrderSnapshot,
  context: ({ input }) => ({
    orderId: input.orderId,
    amountCents: input.amountCents,
    currency: input.currency ?? "USD",
    riskLevel: input.amountCents >= HIGH_RISK_CENTS ? "high" : "low",
    decision: "pending",
  }),
  initial: "awaitingApproval",
  states: {
    awaitingApproval: {
      tags: ["awaiting-approval"],
      on: {
        APPROVE: { target: "settled", context: { decision: "approved" } },
        REJECT: { target: "settled", context: { decision: "rejected" } },
      },
    },
    settled: {
      type: "final",
      output: ({ context }) => ({
        orderId: context.orderId,
        approved: context.decision === "approved",
        amountCents: context.amountCents,
        currency: context.currency,
        riskLevel: context.riskLevel,
      }),
    },
  },
});

export async function runSnapshotMigrationExample(
  input: { orderId?: string; total?: number } = {},
) {
  const { orderId = "ORD-4417", total = 812.5 } = input;
  const paused = await runAgent(orderApprovalMachineV1, { input: { orderId, total } });
  if (paused.status !== "idle") throw new Error(`Expected idle, got '${paused.status}'.`);
  const persisted = persistSnapshot(paused.persist());
  const resumed = await runAgent(orderApprovalMachine, {
    snapshot: persisted,
    event: { type: "APPROVE" },
  });
  if (resumed.status !== "done") throw new Error(`Expected done, got '${resumed.status}'.`);
  return { persisted, output: resumed.output };
}

if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  console.log(await runSnapshotMigrationExample());
}
