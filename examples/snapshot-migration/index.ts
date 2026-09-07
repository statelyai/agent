/** Native XState snapshot versioning and migration through `runAgent`. */
import { z } from "zod";
import type { ContextFrom, Snapshot } from "xstate";
import { runAgent, setupAgent } from "@statelyai/agent";

export const V1 = "1.0.0";
export const V2 = "2.0.0";
export const HIGH_RISK_CENTS = 50_000;

export function persistSnapshot<T>(snapshot: T): T {
  return JSON.parse(JSON.stringify(snapshot)) as T;
}

const v1 = setupAgent({
  context: z.object({ orderId: z.string(), total: z.number() }),
  input: z.object({ orderId: z.string(), total: z.number() }),
  output: z.object({ orderId: z.string(), approved: z.boolean() }),
  events: { APPROVE: z.object({}), REJECT: z.object({ reason: z.string() }) },
});

export const orderApprovalMachineV1 = v1.createMachine({
  id: "order-approval",
  version: V1,
  context: ({ input }) => ({ orderId: input.orderId, total: input.total }),
  initial: "reviewing",
  states: {
    reviewing: {
      tags: ["awaiting-approval"],
      on: { APPROVE: { target: "approved" }, REJECT: { target: "rejected" } },
    },
    // The outcome is the state, not a `decision` field mirroring it.
    approved: {
      type: "final",
      output: ({ context }) => ({ orderId: context.orderId, approved: true }),
    },
    rejected: {
      type: "final",
      output: ({ context }) => ({ orderId: context.orderId, approved: false }),
    },
  },
});

/** The v1 context, read off the v1 machine rather than restated by hand. */
type V1Context = ContextFrom<typeof orderApprovalMachineV1>;

/** A persisted v1 snapshot, as XState hands it to `migrate`. */
type PersistedV1 = Snapshot<unknown> & { value?: unknown; context?: V1Context };

/** XState `migrate` callback: old persisted snapshot in, current snapshot out. */
export function migrateOrderSnapshot(
  snapshot: Snapshot<unknown>,
  fromVersion: string | undefined,
): Snapshot<unknown> {
  if (fromVersion !== V1) return snapshot;
  const old = snapshot as PersistedV1;
  if (!old.context) return snapshot;
  const amountCents = Math.round(old.context.total * 100);
  if (!Number.isSafeInteger(amountCents)) {
    throw new RangeError(
      `Cannot migrate order '${old.context.orderId}': total ${old.context.total} cannot be represented as safe integer cents.`,
    );
  }
  const migrated = {
    ...old,
    version: V2,
    // `approved`/`rejected` kept their names across versions; only the waiting
    // state was renamed.
    value: old.value === "reviewing" ? "awaitingApproval" : old.value,
    context: {
      orderId: old.context.orderId,
      amountCents,
      currency: "USD",
      riskLevel: amountCents >= HIGH_RISK_CENTS ? "high" : "low",
    },
  };
  return migrated as Snapshot<unknown>;
}

const v2 = setupAgent({
  context: z.object({
    orderId: z.string(),
    amountCents: z.number().int(),
    currency: z.string(),
    riskLevel: z.enum(["low", "high"]),
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
  }),
  initial: "awaitingApproval",
  states: {
    awaitingApproval: {
      tags: ["awaiting-approval"],
      on: { APPROVE: { target: "approved" }, REJECT: { target: "rejected" } },
    },
    approved: {
      type: "final",
      output: ({ context }) => ({
        orderId: context.orderId,
        approved: true,
        amountCents: context.amountCents,
        currency: context.currency,
        riskLevel: context.riskLevel,
      }),
    },
    rejected: {
      type: "final",
      output: ({ context }) => ({
        orderId: context.orderId,
        approved: false,
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
