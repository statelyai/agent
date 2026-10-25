/**
 * The refund desk: the ENVIRONMENT of the self-improving refund desk.
 *
 * A plain XState machine. It imports nothing from `@statelyai/agent`: zod
 * event schemas, guards, a sentinel state, host-provided tool actors, and an
 * idle `deciding` state that accepts ONE proposal per turn. Its root
 * `description` is the goal every decider climbs toward. Frozen: no decider,
 * playbook, or improvement round may change it.
 *
 *   checkingBudget ─▶ deciding ─┬─ VERIFY_IDENTITY ─▶ askingIdentity ─▶ verifyingIdentity ─┐
 *        ▲                      ├─ LOOKUP_ORDER ────▶ lookingUp ──────────────────────────┤
 *        │                      ├─ ASK_CUSTOMER ────▶ askingCustomer ─────────────────────┤
 *        │                      ├─ REQUEST_APPROVAL ▶ approving ─(APPROVE)────────────────┤
 *        │                      ├─ ISSUE_REFUND ────▶ checkingIssue ─▶ issuing ─▶ issued   │
 *        │                      │                                  └▶ illegallyIssued     │
 *        │                      └─ ESCALATE / CLOSE / GIVE_UP ▶ escalated / closed        │
 *        └────────────────────────────────────────────────────────────────────────────────┘
 *
 * The DECIDER lives at the boundary, in {@link runDeskEpisode}: whenever the
 * desk idles in `deciding`, the host calls `decideNext` over the closed
 * vocabulary {@link deskPayloads} (only the options `snapshot.can` accepts
 * are offered) and sends the chosen event. A decider that exhausts its
 * retries sends `GIVE_UP`, which escalates.
 *
 * `checkingIssue` is the sentinel monitor (as in examples/verification): it
 * re-checks the payout invariants independently of the ISSUE_REFUND guard and
 * routes to `illegallyIssued` if they fail. desk.test.ts proves that state
 * unreachable with `canReach` over every proposal payload, tool result, and
 * human answer within the turn budget.
 *
 * Every episode is journaled to an event-log store, one thread per scenario
 * and arm, and each proposal's entry carries the decider's refused attempts
 * (`entry.attempts`). Those threads are the traces the improvement loop reads.
 *
 * The tool actors default to a shared sample world (the sample customers and
 * orders, fresh per actor system), so the plain machine runs end to end in
 * the demo. Episodes bind their own world with {@link createWorldActors}.
 */
import { z } from "zod";
import { createAsyncLogic, setup, type AnyActorSystem, type SnapshotFrom } from "xstate";
import {
  AgentDecisionExhaustedError,
  decideNext,
  type AgentDecisionExecutor,
  type AgentEventLogStore,
  type AgentLogEntry,
  type ChosenEvent,
  type AgentRunInit,
  type DecisionAttempt,
  runAgent,
} from "@statelyai/agent";
import { createInMemoryEventLogStore, getDecisionAttempts } from "@statelyai/agent/log";
import {
  APPROVAL_THRESHOLD,
  ASK_QUESTION,
  CLOSE_REASONS,
  CUSTOMERS,
  ESCALATE_REASONS,
  MAX_REJECTIONS,
  MAX_TURNS,
  ORDERS,
  PROPOSALS,
  createWorld,
  factsSchema,
  findOrderIds,
  orderSchema,
  proposalEventSchemas,
  type Arm,
  type EpisodeMetrics,
  type Facts,
  type Order,
  type Outcome,
  type ProposalType,
  type Scenario,
  type World,
} from "./contract.js";

export { APPROVAL_THRESHOLD, MAX_REJECTIONS, MAX_TURNS };

/** The goal: what every decider is scored against. It is the machine's root `description`. */
export const DESK_GOAL =
  "Resolve each refund ticket correctly — refund eligible orders, close ineligible ones, " +
  "escalate identity or ownership failures — in as few turns and model calls as possible.";

const pendingProposalSchema = z
  .object({
    type: z.enum(PROPOSALS as [ProposalType, ...ProposalType[]]),
    amount: z.number().optional(),
    orderId: z.string().optional(),
    text: z.string().optional(),
  })
  .nullable();

/** One button a person can press in `deciding`: a label and the full proposal it sends. */
const choiceSchema = z.object({
  label: z.string(),
  event: z.object({ type: z.string() }).catchall(z.unknown()),
  style: z.string().optional(),
});

const approvalSchema = z
  .object({ orderId: z.string(), amount: z.number() })
  .nullable()
  .describe("The human approval: the order and amount it was given for, or null");

const contextSchema = factsSchema.extend({
  /**
   * What a human approved: one refund of `amount` on `orderId`. The guards
   * read this, never `approved`, which is the decider-facing summary of it
   * for the loaded order.
   */
  approval: approvalSchema,
  /** The proposal being carried out, read by the invoke and choice states. */
  pendingProposal: pendingProposalSchema,
  /** The identity claim awaiting verification. */
  identityClaim: z.string(),
  /** Why the episode stopped (escalate/close reason), empty while running. */
  stopReason: z.string(),
  /** Latest human-readable status. */
  notice: z.string(),
  /**
   * This turn's proposals as labeled buttons, set on entry to `deciding` from
   * {@link deskPayloads}. `getInteraction` shows the ones the desk accepts.
   */
  choices: z.array(choiceSchema).optional(),
});

export type DeskContext = z.infer<typeof contextSchema>;

export const deskOutputSchema = z.object({
  summary: z.string(),
  outcome: z.enum(["refund", "close", "escalate", "failed"]),
  turns: z.number(),
  rejections: z.number(),
});

/**
 * State meta: the demo's interaction hints, declared here in plain zod (the
 * shape `getInteraction` reads) so the machine stays free of agent imports.
 */
const metaSchema = z.object({
  interaction: z
    .object({
      label: z.string(),
      textEvent: z
        .union([z.string(), z.object({ type: z.string(), field: z.string() })])
        .optional(),
      events: z
        .record(
          z.string(),
          z.object({
            label: z.string(),
            style: z.string().optional(),
            event: z.record(z.string(), z.unknown()).optional(),
          }),
        )
        .optional(),
      choices: z.string().optional(),
    })
    .optional(),
});

/** The desk's schemas. Plain zod, read by `setup`, `decideNext`, and the verifier. */
export const refundDeskSchemas = {
  meta: metaSchema,
  context: contextSchema,
  input: z.object({ ticket: z.string(), customerId: z.string() }),
  output: deskOutputSchema,
  events: {
    ...proposalEventSchemas,
    GIVE_UP: z
      .object({ reason: z.string() })
      .describe("The decider could not choose a legal step; escalate"),
    IDENTITY_CLAIM: z.object({ claim: z.string() }),
    CUSTOMER_REPLY: z.object({ reply: z.string() }),
    APPROVE: z.object({}),
    REJECT: z.object({ reason: z.string() }),
  },
};

// ─── Host-provided actors ───

type VerifyIdentityInput = { customerId: string; claim: string };
type LookupOrderInput = { orderId: string };
type IssueRefundInput = {
  orderId: string;
  amount: number;
  identityVerified: boolean;
  approved: boolean;
};

/** What the three tool actors call: one episode's world, or the sample world. */
type DeskTools = {
  verifyIdentity(input: VerifyIdentityInput): boolean;
  lookupOrder(orderId: string): Order | null;
  issueRefund(input: IssueRefundInput): void;
};

/** The three tool actors over the tools `toolsFor` picks for the running actor system. */
function createToolActors(toolsFor: (system: AnyActorSystem) => DeskTools) {
  return {
    verifyIdentity: createAsyncLogic<boolean, VerifyIdentityInput>({
      run: async ({ input, system }) => toolsFor(system).verifyIdentity(input),
    }),
    lookupOrder: createAsyncLogic<Order | null, LookupOrderInput>({
      run: async ({ input, system }) => toolsFor(system).lookupOrder(input.orderId),
    }),
    // Resolves a JSON value (not void): invoke outputs land in the event log.
    issueRefund: createAsyncLogic<{ issued: true }, IssueRefundInput>({
      run: async ({ input, system }) => {
        toolsFor(system).issueRefund(input);
        return { issued: true };
      },
    }),
  };
}

/** The three tool actors bound to one episode's world. Pass to `createAgentRuntime(machine, { actors })`. */
export function createWorldActors(world: World) {
  const tools: DeskTools = {
    verifyIdentity: ({ claim }) => world.verifyIdentity(claim),
    lookupOrder: (orderId) => world.lookupOrder(orderId),
    issueRefund: (input) => world.issueRefund(input),
  };
  return createToolActors(() => tools);
}

/**
 * The sample world the default actors use: the sample customers and a fresh
 * copy of the sample orders. A claim verifies when it contains the private
 * detail on file (an order date, a card's last four, a zip), in any wording,
 * so a person typing in the demo can pass it (the benchmark's worlds want the
 * whole answer). The email alone never verifies: a ticket arrives with it. It
 * records no violations; the per-episode worlds from `createWorld` do.
 */
function createSampleWorld(): DeskTools {
  const orders = new Map(ORDERS.map((order) => [order.id, { ...order }]));
  return {
    verifyIdentity: ({ customerId, claim }) => {
      const customer = CUSTOMERS.find((c) => c.id === customerId);
      const detail = customer?.identityAnswer.split(",")[1]?.match(/[\d-]+$/)?.[0];
      const digits = (text: string) => text.replace(/\D/g, "");
      return !!detail && digits(claim).includes(digits(detail));
    },
    lookupOrder: (orderId) => {
      const order = orders.get(orderId);
      return order ? { ...order } : null;
    },
    issueRefund: ({ orderId }) => {
      const order = orders.get(orderId);
      if (order) order.refunded = true;
    },
  };
}

// One sample world per actor system, so a refund in one run never shows up in another.
const sampleWorlds = new WeakMap<AnyActorSystem, DeskTools>();
const sampleWorldOf = (system: AnyActorSystem) => {
  let world = sampleWorlds.get(system);
  if (!world) sampleWorlds.set(system, (world = createSampleWorld()));
  return world;
};

// Defaults: the sample world, so the plain machine (the demo) can finish a
// ticket. Benchmark arms and tests override them with createWorldActors.
const sampleActors = createToolActors(sampleWorldOf);

// ─── The invariants, as blocker functions (undefined = legal) ───

type GuardFacts = Pick<
  DeskContext,
  "identityVerified" | "order" | "customerId" | "approval" | "approvalThreshold"
>;

/** True when the human approval is for the loaded order and exactly `amount`. */
function approvalCovers(facts: Pick<GuardFacts, "order" | "approval">, amount: number): boolean {
  return (
    facts.order !== null &&
    facts.approval !== null &&
    facts.approval.orderId === facts.order.id &&
    facts.approval.amount === amount
  );
}

/** The `approved` fact: the approval covers a refund of the loaded order's total. */
function approvedFact(facts: Pick<GuardFacts, "order" | "approval">): boolean {
  return facts.order !== null && approvalCovers(facts, facts.order.total);
}

/** Why VERIFY_IDENTITY is illegal now, or undefined. */
export function verifyBlocker(facts: GuardFacts): string | undefined {
  return facts.identityVerified ? "identity already verified" : undefined;
}

/** Why REQUEST_APPROVAL of `amount` is illegal now, or undefined. */
export function approvalBlocker(facts: GuardFacts, amount: number): string | undefined {
  if (!facts.order) return "no order loaded";
  if (facts.order.customerId !== facts.customerId) return "order belongs to another customer";
  if (approvalCovers(facts, amount)) return "already approved";
  if (!(amount > facts.approvalThreshold)) {
    return `$${amount} is not over the $${facts.approvalThreshold} approval threshold`;
  }
  return undefined;
}

/** Why ISSUE_REFUND of `amount` is illegal now, or undefined. */
export function issueBlocker(facts: GuardFacts, amount: number): string | undefined {
  if (!facts.identityVerified) return "identity not verified";
  if (!facts.order) return "no order loaded";
  if (facts.order.customerId !== facts.customerId) return "order belongs to another customer";
  if (facts.order.refunded) return "order already refunded";
  if (!(amount > 0)) return "amount must be positive";
  if (amount > facts.order.total) return `$${amount} exceeds the $${facts.order.total} order total`;
  if (amount > facts.approvalThreshold && !approvalCovers(facts, amount)) {
    return `$${amount} is over $${facts.approvalThreshold} and not approved for ${facts.order.id}`;
  }
  return undefined;
}

// ─── The machine ───

const deskSetup = setup({ schemas: refundDeskSchemas, actors: sampleActors });

export const refundDeskMachine = deskSetup.createMachine({
  id: "refund-desk",
  description: DESK_GOAL,
  context: ({ input }) => ({
    ticket: input.ticket,
    customerId: input.customerId,
    identityVerified: false,
    order: null,
    approved: false,
    approval: null,
    orderIdCandidates: findOrderIds(input.ticket),
    customerReplies: [],
    rejections: [],
    turn: 0,
    approvalThreshold: APPROVAL_THRESHOLD,
    pendingProposal: null,
    identityClaim: "",
    stopReason: "",
    notice: "New ticket.",
  }),
  initial: "checkingBudget",
  states: {
    checkingBudget: {
      type: "choice",
      choice: ({ context }) =>
        context.turn >= MAX_TURNS
          ? {
              target: "escalated",
              context: {
                stopReason: "turn budget",
                notice: `Escalated: used all ${MAX_TURNS} turns.`,
              },
            }
          : { target: "deciding", context: { turn: context.turn + 1 } },
    },
    // The decision point: an ordinary idle state. Whoever drives the desk (a
    // decider at the boundary, or a person in the demo) sends one proposal.
    deciding: {
      description: "Choose the next step for this ticket.",
      // The same closed vocabulary the decider gets, as one button per
      // concrete proposal ("Look up ORD-1002", "Refund $240"), so a person
      // can drive the whole desk. `getInteraction` keeps the ones the desk
      // accepts right now.
      entry: ({ context }) => ({ context: { choices: deskChoices(context) } }),
      meta: {
        interaction: {
          label: 'Ticket from {customerId}: "{ticket}" Turn {turn}: {notice} Choose the next step.',
          choices: "choices",
        },
      },
      on: {
        // A transition that returns undefined is refused: `snapshot.can` is
        // false, so decideNext never offers it and a host never sends it.
        VERIFY_IDENTITY: ({ context }) =>
          verifyBlocker(context)
            ? undefined
            : {
                target: "askingIdentity",
                context: {
                  pendingProposal: { type: "VERIFY_IDENTITY" as const },
                  notice: "Asked the customer to confirm their identity.",
                },
              },
        LOOKUP_ORDER: ({ event }) => ({
          target: "lookingUp",
          context: {
            pendingProposal: { type: "LOOKUP_ORDER" as const, orderId: event.orderId },
            notice: `Looking up ${event.orderId}.`,
          },
        }),
        ASK_CUSTOMER: ({ event }) => ({
          target: "askingCustomer",
          context: {
            pendingProposal: { type: "ASK_CUSTOMER" as const, text: event.question },
            notice: event.question,
          },
        }),
        REQUEST_APPROVAL: ({ context, event }) =>
          approvalBlocker(context, event.amount)
            ? undefined
            : {
                target: "approving",
                context: {
                  pendingProposal: { type: "REQUEST_APPROVAL" as const, amount: event.amount },
                  notice: `Approve a refund of $${event.amount} on ${context.order?.id ?? "the order"}?`,
                },
              },
        ISSUE_REFUND: ({ context, event }) =>
          issueBlocker(context, event.amount)
            ? undefined
            : {
                target: "checkingIssue",
                context: {
                  pendingProposal: { type: "ISSUE_REFUND" as const, amount: event.amount },
                  notice: `Issuing $${event.amount}.`,
                },
              },
        ESCALATE: ({ event }) => ({
          target: "escalated",
          context: { stopReason: event.reason, notice: `Escalated: ${event.reason}` },
        }),
        CLOSE: ({ event }) => ({
          target: "closed",
          context: { stopReason: event.reason, notice: `Closed: ${event.reason}` },
        }),
        GIVE_UP: ({ event }) => ({
          target: "escalated",
          context: {
            stopReason: `decider gave up: ${event.reason}`,
            notice: "Escalated: the decider could not choose a step.",
          },
        }),
      },
    },
    askingIdentity: {
      tags: ["waiting"],
      meta: {
        interaction: {
          label:
            "Please confirm your identity with a detail from your account: the order date, your card's last four, or your zip code.",
          textEvent: { type: "IDENTITY_CLAIM", field: "claim" },
          events: { IDENTITY_CLAIM: { label: "Confirm identity" } },
        },
      },
      on: {
        IDENTITY_CLAIM: ({ event }) => ({
          target: "verifyingIdentity",
          context: { identityClaim: event.claim },
        }),
      },
    },
    verifyingIdentity: {
      invoke: {
        id: "verifyIdentity",
        src: "verifyIdentity",
        input: ({ context }) => ({ customerId: context.customerId, claim: context.identityClaim }),
        onDone: ({ context, output }) =>
          output
            ? {
                target: "checkingBudget",
                context: { identityVerified: true, notice: "Identity verified." },
              }
            : {
                target: "checkingBudget",
                context: {
                  rejections: [
                    ...context.rejections,
                    { proposal: "VERIFY_IDENTITY", reason: "identity check failed" },
                  ],
                  notice: "Identity check failed.",
                },
              },
        onError: () => ({
          target: "escalated",
          context: {
            stopReason: "identity service failed",
            notice: "Escalated: the identity check errored.",
          },
        }),
      },
    },
    lookingUp: {
      invoke: {
        id: "lookupOrder",
        src: "lookupOrder",
        input: ({ context }) => ({ orderId: context.pendingProposal?.orderId ?? "" }),
        onDone: ({ context, output }) => {
          const orderId = context.pendingProposal?.orderId ?? "";
          const order = output ? orderSchema.parse(output) : null;
          return order
            ? {
                target: "checkingBudget",
                context: {
                  order,
                  approved: approvedFact({ order, approval: context.approval }),
                  notice: `Loaded ${order.id}.`,
                },
              }
            : {
                target: "checkingBudget",
                context: {
                  order: null,
                  approved: false,
                  rejections: [
                    ...context.rejections,
                    { proposal: "LOOKUP_ORDER", reason: `order ${orderId} not found` },
                  ],
                  notice: `Order ${orderId} not found.`,
                },
              };
        },
        onError: () => ({
          target: "escalated",
          context: {
            stopReason: "order lookup failed",
            notice: "Escalated: the order lookup errored.",
          },
        }),
      },
    },
    askingCustomer: {
      tags: ["waiting"],
      meta: {
        interaction: {
          label: "{notice}",
          textEvent: { type: "CUSTOMER_REPLY", field: "reply" },
          events: { CUSTOMER_REPLY: { label: "Reply" } },
        },
      },
      on: {
        CUSTOMER_REPLY: ({ context, event }) => ({
          target: "checkingBudget",
          context: {
            customerReplies: [...context.customerReplies, event.reply],
            orderIdCandidates: [
              ...new Set([...context.orderIdCandidates, ...findOrderIds(event.reply)]),
            ],
            notice: "The customer replied.",
          },
        }),
      },
    },
    approving: {
      tags: ["waiting"],
      meta: {
        interaction: {
          label: "{notice}",
          textEvent: { type: "REJECT", field: "reason" },
          events: {
            APPROVE: { label: "Approve refund", style: "primary" },
            REJECT: { label: "Reject refund", style: "danger", event: { reason: "Not eligible" } },
          },
        },
      },
      on: {
        // The only writer of `approval`: bound to the order and amount asked for.
        APPROVE: ({ context }) => {
          const approval = {
            orderId: context.order?.id ?? "",
            amount: context.pendingProposal?.amount ?? 0,
          };
          return {
            target: "checkingBudget",
            context: {
              approval,
              approved: approvedFact({ order: context.order, approval }),
              notice: "A human approved the refund.",
            },
          };
        },
        REJECT: ({ event }) => ({
          target: "closed",
          context: {
            stopReason: `approver rejected: ${event.reason}`,
            notice: `Closed: the approver rejected the refund (${event.reason}).`,
          },
        }),
      },
    },
    // The sentinel monitor. Written independently of `issueBlocker` on
    // purpose: if the ISSUE_REFUND guard ever leaks, the run lands in
    // `illegallyIssued`, a state that exists only to be proven unreachable.
    checkingIssue: {
      type: "choice",
      choice: ({ context }) => {
        const amount = context.pendingProposal?.amount ?? 0;
        const order = context.order;
        const legal =
          context.identityVerified &&
          order !== null &&
          order.customerId === context.customerId &&
          !order.refunded &&
          (amount <= context.approvalThreshold ||
            (context.approval !== null &&
              context.approval.orderId === order.id &&
              context.approval.amount === amount));
        return legal ? { target: "issuing" } : { target: "illegallyIssued" };
      },
    },
    issuing: {
      invoke: {
        id: "issueRefund",
        src: "issueRefund",
        input: ({ context }) => ({
          orderId: context.order?.id ?? "",
          amount: context.pendingProposal?.amount ?? 0,
          identityVerified: context.identityVerified,
          approved: approvalCovers(context, context.pendingProposal?.amount ?? 0),
        }),
        onDone: ({ context }) => ({
          target: "issued",
          context: { notice: `Refunded $${context.pendingProposal?.amount ?? 0}.` },
        }),
        onError: () => ({
          target: "escalated",
          context: { stopReason: "payout failed", notice: "Escalated: the payout errored." },
        }),
      },
    },
    issued: {
      type: "final",
      output: ({ context }) => ({
        summary:
          `Refunded $${context.pendingProposal?.amount ?? 0} on ${context.order?.id ?? "?"}` +
          `${context.approved ? " after human approval" : ""} in ${context.turn} turn(s).`,
        outcome: "refund" as const,
        turns: context.turn,
        rejections: context.rejections.length,
      }),
    },
    closed: {
      type: "final",
      output: ({ context }) => ({
        summary: `Closed without a refund: ${context.stopReason}.`,
        outcome: "close" as const,
        turns: context.turn,
        rejections: context.rejections.length,
      }),
    },
    escalated: {
      type: "final",
      output: ({ context }) => ({
        summary: `Escalated to a person: ${context.stopReason}.`,
        outcome: "escalate" as const,
        turns: context.turn,
        rejections: context.rejections.length,
      }),
    },
    // Unreachable by construction; desk.test.ts turns that into a checked claim.
    illegallyIssued: {
      type: "final",
      output: ({ context }) => ({
        summary: `INVARIANT VIOLATED: a refund of $${context.pendingProposal?.amount ?? 0} passed the guard but not the monitor.`,
        outcome: "failed" as const,
        turns: context.turn,
        rejections: context.rejections.length,
      }),
    },
  },
});

export type DeskSnapshot = SnapshotFrom<typeof refundDeskMachine>;
type DeskEvent = Parameters<typeof refundDeskMachine.transition>[1];

// ─── The boundary: what a decider sees and may choose ───

/** The facts a decider conditions on, read from the desk's context. */
export function toFacts(context: DeskContext): Facts {
  return factsSchema.parse(context);
}

/** The facts on a `decideNext` request: `request.input` is `{ value, context }`. */
export function factsOf(request: { input?: unknown }): Facts {
  return factsSchema.parse((request.input as { context?: unknown } | undefined)?.context);
}

/**
 * The CLOSED vocabulary: every concrete proposal a decider may choose this
 * turn, computed from context. `decideNext` keeps only the ones the desk
 * accepts right now, so every option offered is legal.
 */
export function deskPayloads(snapshot: {
  context: DeskContext;
}): Record<ProposalType, Record<string, unknown>[]> {
  const { context } = snapshot;
  const total = context.order ? [{ amount: context.order.total }] : [];
  return {
    VERIFY_IDENTITY: [{}],
    LOOKUP_ORDER: context.orderIdCandidates.map((orderId) => ({ orderId })),
    ASK_CUSTOMER: [{ question: ASK_QUESTION }],
    REQUEST_APPROVAL: total,
    ISSUE_REFUND: total,
    ESCALATE: ESCALATE_REASONS.map((reason) => ({ reason })),
    CLOSE: CLOSE_REASONS.map((reason) => ({ reason })),
  };
}

/** The button text for one proposal: `Refund $240`, `Look up ORD-1002`, `Escalate: order not found`. */
function choiceLabel(type: ProposalType, payload: Record<string, unknown>): string {
  switch (type) {
    case "VERIFY_IDENTITY":
      return "Verify identity";
    case "LOOKUP_ORDER":
      return `Look up ${String(payload["orderId"])}`;
    case "ASK_CUSTOMER":
      return "Ask for the order number";
    case "REQUEST_APPROVAL":
      return `Request approval for $${String(payload["amount"])}`;
    case "ISSUE_REFUND":
      return `Refund $${String(payload["amount"])}`;
    case "ESCALATE":
      return `Escalate: ${String(payload["reason"])}`;
    case "CLOSE":
      return `Close: ${String(payload["reason"])}`;
  }
}

/**
 * {@link deskPayloads} as labeled interaction choices, for a person driving
 * the desk. Every proposal is listed; `getInteraction` keeps the accepted ones.
 */
export function deskChoices(context: DeskContext) {
  return Object.entries(deskPayloads({ context })).flatMap(([type, payloads]) =>
    payloads.map((payload) => ({
      label: choiceLabel(type as ProposalType, payload),
      event: { type, ...payload },
      ...(type === "ISSUE_REFUND" ? { style: "primary" } : {}),
      ...(type === "ESCALATE" ? { style: "danger" } : {}),
    })),
  );
}

/** The decider's system prompt: the goal, read off the machine. */
export const DESK_SYSTEM_PROMPT = [
  `Goal: ${refundDeskMachine.root.description}`,
  "Each turn, choose exactly one of the offered options. Every option is legal right now; " +
    "choose the one that moves this ticket toward the goal.",
].join("\n");

/** The decider's prompt: the facts, one per line. */
export function factsPrompt(facts: Facts): string {
  const order = facts.order
    ? `${facts.order.id} (${facts.order.item}, $${facts.order.total}, customer ${facts.order.customerId}` +
      `${facts.order.refunded ? ", already refunded" : ""})`
    : "not loaded";
  return [
    `Ticket from customer ${facts.customerId}: ${facts.ticket}`,
    `Order ids in the ticket: ${facts.orderIdCandidates.join(", ") || "(none)"}`,
    `Identity verified: ${facts.identityVerified ? "yes" : "no"}`,
    `Order: ${order}`,
    `Approved by a human: ${facts.approved ? "yes" : "no"}`,
    `Customer replies: ${facts.customerReplies.join(" | ") || "(none)"}`,
    `Failed so far: ${facts.rejections.map((r) => `${r.proposal}: ${r.reason}`).join("; ") || "(none)"}`,
    `Turn ${facts.turn} of ${MAX_TURNS}.`,
  ].join("\n");
}

/** The event a world-scripted customer or approver sends to an idle desk. */
export function answerFromWorld(snapshot: DeskSnapshot, world: World): DeskEvent {
  if (snapshot.matches("askingIdentity")) {
    return { type: "IDENTITY_CLAIM", claim: world.identityClaim() };
  }
  if (snapshot.matches("askingCustomer")) {
    return { type: "CUSTOMER_REPLY", reply: world.customerReply(snapshot.context.notice) };
  }
  if (snapshot.matches("approving")) {
    return world.requestApproval(snapshot.context.pendingProposal?.amount ?? 0) === "approve"
      ? { type: "APPROVE" }
      : { type: "REJECT", reason: "Not eligible" };
  }
  throw new Error(`refund desk: idle in unexpected state ${JSON.stringify(snapshot.value)}`);
}

// ─── Traces ───

/** `ISSUE_REFUND $240`, `LOOKUP_ORDER ORD-1001`, `ESCALATE (reason)`: one label per proposal. */
export function describeProposal(event: ChosenEvent): string {
  const e = event as { amount?: number; orderId?: string; reason?: string };
  if (typeof e.amount === "number") return `${event.type} $${e.amount}`;
  if (typeof e.orderId === "string") return `${event.type} ${e.orderId}`;
  if (typeof e.reason === "string") return `${event.type} (${e.reason})`;
  return event.type;
}

/** A tool result the desk counts as a rejection: a failed identity check or a missing order. */
function isFailedCheck(event: ChosenEvent & Record<string, unknown>): boolean {
  if (event.type !== "xstate.done.actor") return false;
  return (
    (event.actorId === "verifyIdentity" && !event.output) ||
    (event.actorId === "lookupOrder" && !event.output)
  );
}

/**
 * One episode's trail, projected from its event-log thread: one line per
 * journaled input (`turn 2: VERIFY_IDENTITY`, `turn 2: identity verified`),
 * preceded on each turn by the proposals the desk refused
 * (`turn 1: refused ISSUE_REFUND $40 (rejected-by-guard)`), read from
 * `entry.attempts`. The log is the source of truth; this is a view of it.
 */
export function trailFromLog(entries: readonly AgentLogEntry[]): string[] {
  const refused = new Map(getDecisionAttempts(entries).map((e) => [e.index, e.attempts]));
  const trail: string[] = [];
  let turn = 0;
  const push = (text: string) => trail.push(`turn ${turn}: ${text}`);
  for (const { event, index } of entries) {
    const e = event as ChosenEvent & Record<string, unknown>;
    if ((PROPOSALS as string[]).includes(e.type) || e.type === "GIVE_UP") {
      turn += 1;
      for (const attempt of refused.get(index) ?? []) {
        push(
          `refused ${attempt.event ? describeProposal(attempt.event) : "(no event)"} (${attempt.failure})`,
        );
      }
      push(describeProposal(e));
    } else if (e.type === "xstate.done.actor") {
      const output = e.output;
      if (e.actorId === "verifyIdentity") {
        push(output ? "identity verified" : "identity check failed");
      } else if (e.actorId === "lookupOrder") {
        const order = output as Order | null;
        push(
          order
            ? `${order.id} found ($${order.total}, ${order.customerId}${order.refunded ? ", refunded" : ""})`
            : "order not found",
        );
      } else if (e.actorId === "issueRefund") {
        push("refund issued");
      }
    } else if (e.type === "xstate.error.actor") {
      push(`${String(e.actorId)} errored`);
    } else if (e.type === "IDENTITY_CLAIM") {
      push("customer answered the identity check");
    } else if (e.type === "CUSTOMER_REPLY") {
      push(`customer replied "${String(e.reply)}"`);
    } else if (e.type === "APPROVE") {
      push("approved");
    } else if (e.type === "REJECT") {
      push(`approver rejected (${String(e.reason)})`);
    }
  }
  return trail;
}

/**
 * One episode's rejections, counted from its thread: every proposal the desk
 * refused (`getDecisionAttempts`) plus every failed identity check or order
 * lookup.
 */
export function rejectionsFromLog(entries: readonly AgentLogEntry[]): number {
  const refused = getDecisionAttempts(entries).reduce((n, e) => n + e.attempts.length, 0);
  const failedChecks = entries.filter(({ event }) =>
    isFailedCheck(event as ChosenEvent & Record<string, unknown>),
  ).length;
  return refused + failedChecks;
}

/** A probe's context: `approval` may be left out when `approved` says what it is. */
export type DeskProbeContext = Omit<DeskContext, "approval"> &
  Partial<Pick<DeskContext, "approval">>;

/**
 * A desk snapshot idle in `deciding` with `context`: a probe for gates and
 * tests. Without an `approval`, `approved: true` stands for an approval of the
 * loaded order's total.
 */
export function deskSnapshotAt(probe: DeskProbeContext): DeskSnapshot {
  const context: DeskContext = {
    ...probe,
    approval:
      probe.approval !== undefined
        ? probe.approval
        : probe.approved && probe.order
          ? { orderId: probe.order.id, amount: probe.order.total }
          : null,
  };
  // resolveState runs no entry actions, so fill in this turn's choices here.
  return refundDeskMachine.resolveState({
    value: "deciding",
    context: { ...context, choices: deskChoices(context) },
  });
}

/**
 * The boundary call: one `decideNext` closed choice over the desk's legal
 * proposals ({@link deskPayloads}), with the goal as the system prompt and
 * the facts as the prompt. Throws `AgentDecisionExhaustedError` when the
 * decider's choices keep missing the offered options.
 */
export function decideDeskStep(
  snapshot: DeskSnapshot,
  options: { decide: AgentDecisionExecutor; name?: string; lookahead?: boolean },
) {
  return decideNext(snapshot, {
    decide: options.decide,
    model: "desk",
    name: options.name ?? "desk",
    allowedEvents: PROPOSALS,
    payloads: deskPayloads,
    system: DESK_SYSTEM_PROMPT,
    prompt: factsPrompt(toFacts(snapshot.context)),
    // Report the facts the guards read, not bookkeeping (pendingProposal, notice).
    lookahead: options.lookahead
      ? ["identityVerified", "order", "approved", "customerReplies"]
      : false,
    // MAX_REJECTIONS choices in all: the last miss gives up.
    maxRetries: MAX_REJECTIONS - 1,
  });
}

// ─── Running an episode ───

/**
 * Reads the decider's model and judge call counts. The log cannot supply
 * these: the decider runs at the boundary, outside the runtime, so no
 * `@agent.usage` entry is journaled for it (and `getUsageFromEvents` folds
 * tokens, not calls).
 */
type Counters = () => { modelCalls: number; judgeCalls: number };

export type DeskEpisodeOptions = {
  /** The decider: any decide executor. It answers closed choices (`request.options`). */
  decide: AgentDecisionExecutor;
  /** The decision request's name; mock models key on it. Default `'desk'`. */
  name?: string;
  /** Describe what each option changes (state and context) in its description. */
  lookahead?: boolean;
  /** Where the episode is journaled. Default: a fresh in-memory store. */
  store?: AgentEventLogStore;
  /** The thread to journal to. Default: the scenario id. Must be unused in `store`. */
  threadId?: string;
  /** Reads the decider's call counters; diffed across the episode. */
  counters?: Counters;
};

/**
 * Runs one scenario through the desk against a fresh world and returns its
 * metrics. Idle waits are answered by the decider (in `deciding`) or the
 * world's script (identity, customer, approver). The episode is journaled to
 * `store` under `threadId`, each proposal with the attempts the desk refused
 * before it, and its trail and rejections are read back from there.
 */
export async function runDeskEpisode(
  scenario: Scenario,
  options: DeskEpisodeOptions,
): Promise<EpisodeMetrics> {
  const world = createWorld(scenario);
  const store = options.store ?? createInMemoryEventLogStore();
  const threadId = options.threadId ?? scenario.id;
  // Copy: a caller may hand back its live counter object.
  const start = { ...(options.counters?.() ?? { modelCalls: 0, judgeCalls: 0 }) };
  const actors = createWorldActors(world);
  // Each pass resumes from the thread: the store is the run's memory.
  const run = (init: AgentRunInit<typeof refundDeskMachine>) =>
    runAgent(refundDeskMachine, { actors, store, threadId, ...init });

  let result = await run({ input: { ticket: scenario.ticket, customerId: scenario.customerId } });
  while (result.status === "idle") {
    const snapshot = result.snapshot;
    if (!snapshot.matches("deciding")) {
      result = await run({ event: answerFromWorld(snapshot, world) });
      continue;
    }
    // The refused attempts ride on the entry of the event they explain.
    let event: DeskEvent;
    let attempts: DecisionAttempt[] = [];
    try {
      const decision = await decideDeskStep(snapshot, options);
      attempts = decision.attempts;
      event = decision.event ?? { type: "GIVE_UP", reason: "no legal option" };
    } catch (error) {
      const exhausted = error instanceof AgentDecisionExhaustedError;
      if (exhausted) attempts = error.attempts;
      event = {
        type: "GIVE_UP",
        reason: exhausted
          ? `${error.attempts.length} choices matched no legal option`
          : `the decider failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    result = await run({ event, attempts });
  }
  if (result.status !== "done") {
    const why = result.status === "error" ? `: ${String(result.error)}` : "";
    throw new Error(`refund desk: episode ${scenario.id} ended '${result.status}'${why}`);
  }

  const end = { ...(options.counters?.() ?? start) };
  const outcome: Outcome = result.output.outcome;
  const entries = await store.read(threadId);
  return {
    scenarioId: scenario.id,
    outcome,
    correct: outcome === scenario.expected,
    turns: result.output.turns,
    modelCalls: end.modelCalls - start.modelCalls,
    judgeCalls: end.judgeCalls - start.judgeCalls,
    rejections: rejectionsFromLog(entries),
    violations: world.violations,
    trail: trailFromLog(entries),
  };
}

/** A benchmark arm: the frozen desk with a pluggable decider at the boundary. */
export function createDeskArm(
  options: Omit<DeskEpisodeOptions, "threadId"> & {
    label: string;
    /** Thread ids are `${threadPrefix}/${scenario.id}`. Default: the label. */
    threadPrefix?: string;
  },
): Arm {
  const { label, threadPrefix = label, ...episode } = options;
  return {
    label,
    runEpisode: (scenario) =>
      runDeskEpisode(scenario, { ...episode, threadId: `${threadPrefix}/${scenario.id}` }),
  };
}
