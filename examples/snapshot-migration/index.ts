/** Native XState snapshot versioning and migration through `runAgent`. */
import { z } from "zod";
import type { AnyStateMachine, ContextFrom, Snapshot } from "xstate";
import {
  createAgentRuntime,
  runToQuiescence,
  setupAgent,
  type AgentRuntimeOptions,
  type AgentRunInit,
} from "@statelyai/agent";

/**
 * The seams a host threads through every leg of a multi-run example: its
 * executors, its cancellation signal, and the observers that make one story
 * out of several `runAgent` calls. Declared here, not imported, so the example
 * stays a single self-contained file (see CONTRIBUTING).
 */
type ExampleRunOptions = Pick<
  AgentRuntimeOptions<AnyStateMachine> & AgentRunInit<AnyStateMachine>,
  "executors" | "signal" | "onTransition" | "on" | "onTrace" | "inspect"
>;

export const V1 = "1.0.0";
export const V2 = "2.0.0";
export const HIGH_RISK_CENTS = 50_000;

/** Integer cents as a reviewer reads them: `2500, "USD"` → `"$25.00"`. */
export function formatMoney(amountCents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amountCents / 100);
}

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
      description: "Order {orderId} ({total}) is waiting for a reviewer.",
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
      amountDisplay: formatMoney(amountCents, "USD"),
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
    /**
     * `amountCents` formatted for people ("$25.00"). Stored, not derived at
     * read time, because a state `description` can only interpolate context —
     * and the amount never changes, so there is nothing to keep in sync.
     */
    amountDisplay: z.string(),
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
    /** Formatted for people ("$812.50"); integer cents stay in context. */
    amount: z.string(),
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
    amountDisplay: formatMoney(input.amountCents, input.currency ?? "USD"),
    riskLevel: input.amountCents >= HIGH_RISK_CENTS ? "high" : "low",
  }),
  initial: "awaitingApproval",
  states: {
    awaitingApproval: {
      tags: ["awaiting-approval"],
      description: "Order {orderId} ({amountDisplay}, {riskLevel} risk) is waiting for a reviewer.",
      on: { APPROVE: { target: "approved" }, REJECT: { target: "rejected" } },
    },
    approved: {
      type: "final",
      output: ({ context }) => ({
        orderId: context.orderId,
        approved: true,
        amount: context.amountDisplay,
        riskLevel: context.riskLevel,
      }),
    },
    rejected: {
      type: "final",
      output: ({ context }) => ({
        orderId: context.orderId,
        approved: false,
        amount: context.amountDisplay,
        riskLevel: context.riskLevel,
      }),
    },
  },
});

/**
 * Leg one: run the deployed v1 machine until it waits for a reviewer, and
 * persist that snapshot as a host would. Exported for callers that want the
 * raw persisted snapshot; the story runner below keeps it out of its result.
 */
export async function pauseOnV1(
  options: { orderId?: string; total?: number } & ExampleRunOptions = {},
) {
  const { orderId = "ORD-4417", total = 812.5, ...observers } = options;
  const paused = await runToQuiescence(
    createAgentRuntime(orderApprovalMachineV1, {
      ...(observers as object),
    }),
    {
      ...(observers as object),
      input: { orderId, total },
    },
  );
  if (paused.status !== "idle") throw new Error(`Expected idle, got '${paused.status}'.`);
  return persistSnapshot(paused.persist());
}

/**
 * The whole story in one call: pause on the deployed machine, ship a new
 * version, resume the paused snapshot on it. The migration happens BETWEEN the
 * two runs, so a host that drives only one machine cannot show it — see
 * {@link ExampleRunOptions}, whose observers are threaded into both legs.
 * Returns the readable summary and the v2 output; the raw persisted snapshot
 * is evidence for programmatic callers ({@link pauseOnV1}), not the result.
 */
export async function runSnapshotMigrationExample(
  options: { orderId?: string; total?: number } & ExampleRunOptions = {},
) {
  const { orderId = "ORD-4417", total = 812.5, ...observers } = options;
  const persisted = await pauseOnV1({ orderId, total, ...observers });
  // The version bump: the paused snapshot is resumed on a machine that has
  // shipped since, through XState's own `version` + `migrate` contract.
  const resumed = await runToQuiescence(
    createAgentRuntime(orderApprovalMachine, {
      ...(observers as object),
    }),
    {
      ...(observers as object),
      snapshot: persisted,
      event: { type: "APPROVE" },
    },
  );
  if (resumed.status !== "done") throw new Error(`Expected done, got '${resumed.status}'.`);
  const { output } = resumed;
  const { amountCents } = resumed.snapshot.context;
  const pausedIn = String((persisted as { value?: unknown }).value);
  const summary = [
    `Paused order ${orderId} (total ${total}) on v${V1}, waiting in \`${pausedIn}\`.`,
    `Shipped v${V2}: the waiting state is now \`awaitingApproval\`, and amounts are integer cents with a currency and a risk level.`,
    `On resume, XState read the snapshot's version (${V1}) and ran the v${V2} machine's \`migrate\`: ` +
      `\`${pausedIn}\` → \`awaitingApproval\`, total ${total} → ${amountCents} cents ` +
      `(${output.amount}), risk ${output.riskLevel}.`,
    `APPROVE then landed on v${V2}: order ${output.orderId} ${output.approved ? "approved" : "rejected"}.`,
  ].join("\n\n");
  return { summary, output };
}

if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  console.log(await runSnapshotMigrationExample());
}
