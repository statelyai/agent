/**
 * Snapshot migration — resuming a paused run after you shipped a new machine.
 *
 * An order-approval flow pauses idle waiting for a human. Between the pause and
 * the approval, v2 of the machine ships: the idle state is renamed, `total`
 * becomes `amountCents`, and `currency`/`riskLevel` join the context. The
 * persisted v1 snapshot is now stale — its state value does not exist and its
 * context has the wrong shape.
 *
 * Demonstrates the three pieces `runAgent` gives you for that:
 *   - `machineVersion` — the stamp written onto every settled snapshot's
 *     `agentMeta` (defaults to the machine's own `version`, else
 *     `getMachineStructuralHash(machine)`, which changes on any structural
 *     edit). Both machines here set it explicitly, so the boundary is a
 *     deliberate "1.0.0" → "2.0.0" and not an accident of hashing.
 *   - `onVersionMismatch` — `'throw'` (the default) turns a stale resume into
 *     an `AgentSnapshotVersionMismatchError` carrying `from`/`to`, instead of
 *     restoring garbage. `'warn'`/`'ignore'` opt out.
 *   - `migrateSnapshot` — a pure `(snapshot, { from, to }) => snapshot` hook
 *     that runs *instead of* `onVersionMismatch`, so old snapshots are adapted
 *     at the boundary rather than everywhere downstream.
 *
 * Both machines live in this one file on purpose: v1 is what shipped, v2 is
 * what shipped next, and `migrateOrderSnapshot` is the diff between them
 * expressed as data.
 *
 * No API key needed: nothing here calls a model. Run:
 * npx tsx examples/snapshot-migration/index.ts
 */
import { z } from "zod";
import {
  AgentSnapshotVersionMismatchError,
  persistSnapshot,
  runAgent,
  setupAgent,
} from "@statelyai/agent";
import type { Snapshot } from "xstate";

/** The version stamped on snapshots produced by {@link orderApprovalMachineV1}. */
export const V1 = "1.0.0";
/** The version stamped on snapshots produced by {@link orderApprovalMachine}. */
export const V2 = "2.0.0";

// ─── v1: what shipped first ───

const v1Setup = setupAgent({
  context: z.object({
    orderId: z.string(),
    // Dollars, as a float. This is the mistake v2 fixes.
    total: z.number(),
    decision: z.enum(["pending", "approved", "rejected"]),
  }),
  input: z.object({ orderId: z.string(), total: z.number() }),
  output: z.object({ orderId: z.string(), approved: z.boolean() }),
  events: {
    APPROVE: z.object({}),
    REJECT: z.object({ reason: z.string() }),
  },
  // The idle gate is declared by the machine, so `runAgent` settles
  // `{ status: 'idle', snapshot }` deterministically rather than by timing.
  isSuspended: (snapshot) => snapshot.hasTag("awaiting-approval"),
});

/** v1 of the order-approval flow. Kept exported so the old snapshot is real, not hand-written. */
export const orderApprovalMachineV1 = v1Setup.createMachine({
  id: "order-approval",
  context: ({ input }) => ({
    orderId: input.orderId,
    total: input.total,
    decision: "pending" as const,
  }),
  initial: "reviewing",
  states: {
    // v2 renames this state, which is what makes a raw v1 snapshot unusable.
    reviewing: {
      tags: ["awaiting-approval"],
      on: {
        APPROVE: () => ({ target: "settled", context: { decision: "approved" as const } }),
        REJECT: () => ({ target: "settled", context: { decision: "rejected" as const } }),
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

// ─── v2: what shipped next ───

const v2Setup = setupAgent({
  context: z.object({
    orderId: z.string(),
    // Renamed and re-scaled: integer cents, never a float.
    amountCents: z.number().int(),
    // New in v2.
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
  events: {
    APPROVE: z.object({}),
    REJECT: z.object({ reason: z.string() }),
  },
  meta: z.object({
    interaction: z
      .object({
        label: z.string(),
        events: z
          .record(
            z.string(),
            z.object({
              label: z.string().optional(),
              style: z.enum(["primary", "danger", "default"]).optional(),
            }),
          )
          .optional(),
        textEvent: z.string().optional(),
      })
      .optional(),
  }),
  isSuspended: (snapshot) => snapshot.hasTag("awaiting-approval"),
});

/** Anything at or above this is `riskLevel: 'high'`. New rule in v2. */
export const HIGH_RISK_CENTS = 50_000;

/** v2 of the order-approval flow — the current machine. */
export const orderApprovalMachine = v2Setup.createMachine({
  id: "order-approval",
  context: ({ input }) => ({
    orderId: input.orderId,
    amountCents: input.amountCents,
    currency: input.currency ?? "USD",
    riskLevel: input.amountCents >= HIGH_RISK_CENTS ? ("high" as const) : ("low" as const),
    decision: "pending" as const,
  }),
  initial: "awaitingApproval",
  states: {
    // Renamed from v1's `reviewing`.
    awaitingApproval: {
      tags: ["awaiting-approval"],
      meta: {
        interaction: {
          label: "Approve this order, or reject it with a reason.",
          events: {
            APPROVE: { label: "Approve order", style: "primary" },
            REJECT: { label: "Reject order", style: "danger" },
          },
          textEvent: "REJECT",
        },
      },
      on: {
        APPROVE: () => ({ target: "settled", context: { decision: "approved" as const } }),
        REJECT: () => ({ target: "settled", context: { decision: "rejected" as const } }),
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

// ─── the migration ───

/** The v1 context shape, as it appears inside a persisted v1 snapshot. */
interface V1Context {
  orderId: string;
  total: number;
  decision: "pending" | "approved" | "rejected";
}

/**
 * v1 snapshot → v2 snapshot. Pure: it reads the old shape and returns the new
 * one, touching nothing else on the snapshot. Two edits, mirroring the two
 * things v2 changed:
 *
 *   1. `value: 'reviewing'` → `'awaitingApproval'` (the renamed state).
 *   2. `total` (dollars) → `amountCents` (integer cents), plus the new
 *      `currency` and derived `riskLevel` fields.
 *
 * Passed as `runAgent({ migrateSnapshot })`, it runs *instead of*
 * `onVersionMismatch` and its return value is the snapshot the run resumes
 * from.
 */
export function migrateOrderSnapshot(snapshot: Snapshot<unknown>): Snapshot<unknown> {
  const old = snapshot as Snapshot<unknown> & { value?: unknown; context?: V1Context };
  const context = old.context;
  if (!context) {
    return snapshot;
  }
  const amountCents = Math.round(context.total * 100);
  return {
    ...old,
    value: old.value === "reviewing" ? "awaitingApproval" : old.value,
    context: {
      orderId: context.orderId,
      amountCents,
      currency: "USD",
      riskLevel: amountCents >= HIGH_RISK_CENTS ? "high" : "low",
      decision: context.decision,
    },
  } as unknown as Snapshot<unknown>;
}

// ─── the three acts ───

export interface SnapshotMigrationResult {
  /** The persisted (JSON-round-tripped) v1 idle snapshot. */
  persisted: unknown;
  /** The version stamped on that snapshot's `agentMeta`. */
  stampedVersion: string | undefined;
  /** The error v2 threw when handed the v1 snapshot with the default `'throw'`. */
  mismatch: AgentSnapshotVersionMismatchError;
  /** The `{ from, to }` pair `migrateSnapshot` was called with. */
  migrationInfo: { from: string; to: string } | undefined;
  /** v2's output after the migrated snapshot resumed and was approved. */
  output: {
    orderId: string;
    approved: boolean;
    amountCents: number;
    currency: string;
    riskLevel: "low" | "high";
  };
}

/**
 * Runs the whole story: v1 pauses and is persisted, v2 refuses the stale
 * snapshot, then v2 accepts it through `migrateSnapshot` and runs to done.
 */
export async function runSnapshotMigrationExample(
  input: { orderId?: string; total?: number } = {},
): Promise<SnapshotMigrationResult> {
  const { orderId = "ORD-4417", total = 812.5 } = input;

  // Act 1 — v1 runs to its idle gate and the snapshot is persisted as JSON.
  const paused = await runAgent(orderApprovalMachineV1, {
    input: { orderId, total },
    machineVersion: V1,
  });
  if (paused.status !== "idle") {
    throw new Error(`Expected v1 to settle idle, got '${paused.status}'.`);
  }
  const persisted = persistSnapshot(paused.snapshot);
  const stampedVersion = (persisted as { agentMeta?: { version?: string } }).agentMeta?.version;

  // Act 2 — v2 refuses it. The default `onVersionMismatch: 'throw'` is what
  // stands between a shipped rename and a silently corrupt resume.
  let mismatch: AgentSnapshotVersionMismatchError | undefined;
  try {
    await runAgent(orderApprovalMachine, {
      snapshot: persisted as never,
      event: { type: "APPROVE" },
      machineVersion: V2,
    });
  } catch (error) {
    if (!(error instanceof AgentSnapshotVersionMismatchError)) {
      throw error;
    }
    mismatch = error;
  }
  if (!mismatch) {
    throw new Error("Expected v2 to reject the v1 snapshot.");
  }

  // Act 3 — the same snapshot, adapted at the boundary, resumes and completes.
  let migrationInfo: { from: string; to: string } | undefined;
  const resumed = await runAgent(orderApprovalMachine, {
    snapshot: persisted as never,
    event: { type: "APPROVE" },
    machineVersion: V2,
    migrateSnapshot: (snapshot, info) => {
      migrationInfo = info;
      return migrateOrderSnapshot(snapshot);
    },
  });
  if (resumed.status !== "done") {
    throw new Error(`Expected v2 to finish after migrating, got '${resumed.status}'.`);
  }

  return { persisted, stampedVersion, mismatch, migrationInfo, output: resumed.output };
}

/** Narrated walkthrough of the three acts. Keyless. */
export async function main(): Promise<void> {
  const orderId = "ORD-4417";
  const total = 812.5;

  console.log("Act 1 — v1 pauses for a human and the snapshot is persisted");
  const paused = await runAgent(orderApprovalMachineV1, {
    input: { orderId, total },
    machineVersion: V1,
  });
  if (paused.status !== "idle") {
    throw new Error(`Expected v1 to settle idle, got '${paused.status}'.`);
  }
  const persisted = persistSnapshot(paused.snapshot);
  const meta = (persisted as { agentMeta?: { version?: string } }).agentMeta;
  console.log(`  state:   ${JSON.stringify((persisted as { value?: unknown }).value)}`);
  console.log(`  context: ${JSON.stringify((persisted as { context?: unknown }).context)}`);
  console.log(`  stamped: agentMeta.version = ${JSON.stringify(meta?.version)}`);

  console.log("\nAct 2 — v2 shipped; resuming the v1 snapshot throws by default");
  try {
    await runAgent(orderApprovalMachine, {
      snapshot: persisted as never,
      event: { type: "APPROVE" },
      machineVersion: V2,
      onVersionMismatch: "throw", // the default, spelled out
    });
    console.log("  (unreachable — the stale snapshot was accepted)");
  } catch (error) {
    if (!(error instanceof AgentSnapshotVersionMismatchError)) {
      throw error;
    }
    console.log(`  ${error.name}: from '${error.from}' to '${error.to}'`);
    console.log(`  machineId: ${error.machineId}`);
  }

  console.log("\nAct 3 — migrateSnapshot adapts it at the boundary, and the run completes");
  const resumed = await runAgent(orderApprovalMachine, {
    snapshot: persisted as never,
    event: { type: "APPROVE" },
    machineVersion: V2,
    migrateSnapshot: (snapshot, info) => {
      const migrated = migrateOrderSnapshot(snapshot);
      console.log(`  migrating '${info.from}' → '${info.to}'`);
      console.log(`  before: ${JSON.stringify((snapshot as { context?: unknown }).context)}`);
      console.log(`  after:  ${JSON.stringify((migrated as { context?: unknown }).context)}`);
      return migrated;
    },
  });
  if (resumed.status !== "done") {
    throw new Error(`Expected v2 to finish after migrating, got '${resumed.status}'.`);
  }
  console.log(`  output: ${JSON.stringify(resumed.output)}`);

  console.log("\nThe rename was survivable because the snapshot knew which machine wrote it.");
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
