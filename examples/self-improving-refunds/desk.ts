/**
 * The refund desk: the OUTER machine of the self-improving refund desk.
 *
 * Frozen policy. Every turn the desk asks a pluggable `decide` executor for ONE
 * proposal from `PROPOSALS` (see contract.ts), and the desk's guards decide
 * whether that proposal is legal. A raw model, a scripted test double, and a
 * playbook machine wrapped as a decide executor all plug into the same slot;
 * the desk behaves identically whatever decides.
 *
 *   checkingBudget ─▶ deciding ─┬─ VERIFY_IDENTITY ─▶ askingIdentity ─▶ verifyingIdentity ─┐
 *        ▲                      ├─ LOOKUP_ORDER ────▶ lookingUp ──────────────────────────┤
 *        │                      ├─ ASK_CUSTOMER ────▶ askingCustomer ─────────────────────┤
 *        │                      ├─ REQUEST_APPROVAL ▶ approving ─(APPROVE)────────────────┤
 *        │                      ├─ ISSUE_REFUND ────▶ checkingIssue ─▶ issuing ─▶ issued   │
 *        │                      │                                  └▶ illegallyIssued     │
 *        │                      └─ ESCALATE / CLOSE ▶ escalated / closed                  │
 *        └────────────────────────────────────────────────────────────────────────────────┘
 *
 * The decider sees the facts as the decision request's `input`: the
 * `agent.decide` invoke input spreads `Facts` alongside `model`/`prompt`, so
 * `factsSchema.parse(request.input)` (or {@link factsOf}) recovers them.
 *
 * `checkingIssue` is the sentinel monitor (as in examples/verification): it
 * re-checks the payout invariants independently of the ISSUE_REFUND guard and
 * routes to `illegallyIssued` if they fail. desk.test.ts proves that state
 * unreachable for every sequence of proposals, payloads, tool results and
 * human answers within the turn budget.
 *
 * Where guard rejections are recorded:
 *   - The runtime retries a guard-rejected proposal inside the same decide
 *     invoke and hands the decider the failures as `request.attempts`. There is
 *     no trace event for a rejected attempt and a guard returning `undefined`
 *     records nothing, so the machine never sees an attempt that a later retry
 *     replaced.
 *   - So the machine keeps `context.rejections` for what it can see: a failed
 *     identity check, an order that does not exist, and, when the decider
 *     exhausts its retries, the full `attempts` list carried by
 *     `AgentDecisionExhaustedError` (read in the invoke's `onError`).
 *   - {@link runDeskEpisode} wraps the decide executor to observe
 *     `request.attempts` and adds those rejections to the metrics and the
 *     trail, explained by the same blocker functions the guards use.
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAsyncLogic, type SnapshotFrom } from "xstate";
import {
  AgentDecisionExhaustedError,
  createAgentRuntime,
  createAgentSchemas,
  interactionMetaSchema,
  runToQuiescence,
  setupAgent,
  type AgentDecisionExecutor,
  type ChosenEvent,
  type DecisionAttempt,
} from "@statelyai/agent";
import {
  APPROVAL_THRESHOLD,
  MAX_REJECTIONS,
  MAX_TURNS,
  PROPOSALS,
  createWorld,
  factsSchema,
  findOrderIds,
  orderSchema,
  proposalEventSchemas,
  rejectionSchema,
  type Arm,
  type EpisodeMetrics,
  type Facts,
  type Order,
  type Outcome,
  type Scenario,
  type World,
} from "./contract.js";

export { APPROVAL_THRESHOLD, MAX_REJECTIONS, MAX_TURNS };

// Declared so the desk is playable against a real model; tests never call it.
const models = {
  desk: openai("gpt-5.4-mini"),
};

const pendingProposalSchema = z
  .object({
    type: z.enum(PROPOSALS as [string, ...string[]]),
    amount: z.number().optional(),
    orderId: z.string().optional(),
    text: z.string().optional(),
  })
  .nullable();

const contextSchema = factsSchema.extend({
  /** The proposal being carried out, read by the choice and invoke states. */
  pendingProposal: pendingProposalSchema,
  /** The identity claim awaiting verification. */
  identityClaim: z.string(),
  identityAttempts: z.number(),
  /** Why the episode stopped (escalate/close reason), empty while running. */
  stopReason: z.string(),
  /** Latest human-readable status. */
  notice: z.string(),
  /** One short line per step. */
  trail: z.array(z.string()),
});

export type DeskContext = z.infer<typeof contextSchema>;

export const deskOutputSchema = z.object({
  summary: z.string(),
  outcome: z.enum(["refund", "close", "escalate", "failed"]),
  turns: z.number(),
  rejections: z.number(),
  trail: z.array(z.string()),
});

export const refundDeskSchemas = createAgentSchemas({
  context: contextSchema,
  input: z.object({ ticket: z.string(), customerId: z.string() }),
  output: deskOutputSchema,
  meta: interactionMetaSchema,
  events: {
    ...proposalEventSchemas,
    IDENTITY_CLAIM: z.object({ claim: z.string() }),
    CUSTOMER_REPLY: z.object({ reply: z.string() }),
    APPROVE: z.object({}),
    REJECT: z.object({ reason: z.string().default("Not eligible") }),
  },
});

// ─── Host-provided actors ───

type VerifyIdentityInput = { customerId: string; claim: string };
type LookupOrderInput = { orderId: string };
type IssueRefundInput = {
  orderId: string;
  amount: number;
  identityVerified: boolean;
  approved: boolean;
};

/** The three tool actors bound to one episode's world. Pass to `createAgentRuntime(machine, { actors })`. */
export function createWorldActors(world: World) {
  return {
    verifyIdentity: createAsyncLogic<boolean, VerifyIdentityInput>({
      run: async ({ input }) => world.verifyIdentity(input.claim),
    }),
    lookupOrder: createAsyncLogic<Order | null, LookupOrderInput>({
      run: async ({ input }) => world.lookupOrder(input.orderId),
    }),
    // Resolves a JSON value (not void): invoke outputs land in the run's
    // JSON event log.
    issueRefund: createAsyncLogic<{ issued: true }, IssueRefundInput>({
      run: async ({ input }) => {
        world.issueRefund(input);
        return { issued: true };
      },
    }),
  };
}

const noWorld = (name: string) => () => {
  throw new Error(
    `refund desk: '${name}' has no world bound. Pass createWorldActors(world) as ` +
      "createAgentRuntime(refundDeskMachine, { actors }).",
  );
};

// Defaults so the machine builds; every run overrides them.
const unboundActors = {
  verifyIdentity: createAsyncLogic<boolean, VerifyIdentityInput>({
    run: async () => noWorld("verifyIdentity")(),
  }),
  lookupOrder: createAsyncLogic<Order | null, LookupOrderInput>({
    run: async () => noWorld("lookupOrder")(),
  }),
  issueRefund: createAsyncLogic<{ issued: true }, IssueRefundInput>({
    run: async () => noWorld("issueRefund")(),
  }),
};

// ─── The invariants, as blocker functions (undefined = legal) ───

type GuardFacts = Pick<
  Facts,
  "identityVerified" | "order" | "customerId" | "approved" | "approvalThreshold"
>;

/** Why VERIFY_IDENTITY is illegal now, or undefined. */
export function verifyBlocker(facts: GuardFacts): string | undefined {
  return facts.identityVerified ? "identity already verified" : undefined;
}

/** Why REQUEST_APPROVAL of `amount` is illegal now, or undefined. */
export function approvalBlocker(facts: GuardFacts, amount: number): string | undefined {
  if (!facts.order) return "no order loaded";
  if (facts.order.customerId !== facts.customerId) return "order belongs to another customer";
  if (facts.approved) return "already approved";
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
  if (amount > facts.approvalThreshold && !facts.approved) {
    return `$${amount} is over $${facts.approvalThreshold} and not approved`;
  }
  return undefined;
}

/** Why a proposal is illegal against `facts`, or undefined when the desk would take it. */
export function proposalBlocker(facts: GuardFacts, event: ChosenEvent): string | undefined {
  const amount = (event as { amount?: number }).amount ?? Number.NaN;
  switch (event.type) {
    case "VERIFY_IDENTITY":
      return verifyBlocker(facts);
    case "REQUEST_APPROVAL":
      return approvalBlocker(facts, amount);
    case "ISSUE_REFUND":
      return issueBlocker(facts, amount);
    default:
      return undefined;
  }
}

/** `ISSUE_REFUND $240`, `LOOKUP_ORDER ORD-1001`, `ESCALATE` — one short label for a trail line. */
export function describeProposal(event: ChosenEvent): string {
  const e = event as { amount?: number; orderId?: string };
  if (typeof e.amount === "number") return `${event.type} $${e.amount}`;
  if (typeof e.orderId === "string") return `${event.type} ${e.orderId}`;
  return event.type;
}

/** The facts the decider sees, built from the desk's context. */
export function toFacts(context: DeskContext): Facts {
  return {
    ticket: context.ticket,
    customerId: context.customerId,
    identityVerified: context.identityVerified,
    order: context.order,
    approved: context.approved,
    orderIdCandidates: context.orderIdCandidates,
    customerReplies: context.customerReplies,
    rejections: context.rejections,
    turn: context.turn,
    approvalThreshold: context.approvalThreshold,
  };
}

/** The facts carried on a decision request's `input`. */
export function factsOf(request: { input?: unknown }): Facts {
  return factsSchema.parse(request.input);
}

const DESK_SYSTEM_PROMPT = [
  "You run a refund desk. Each turn, choose exactly ONE next step.",
  "VERIFY_IDENTITY asks the customer to confirm who they are. LOOKUP_ORDER loads an order.",
  "ASK_CUSTOMER asks one question (for example, a missing order id).",
  `REQUEST_APPROVAL routes a refund over $${APPROVAL_THRESHOLD} to a human approver.`,
  "ISSUE_REFUND pays out; it needs a verified identity, the customer's own unrefunded order, " +
    `an amount no larger than the order total, and approval when over $${APPROVAL_THRESHOLD}.`,
  "ESCALATE hands the case to a person. CLOSE ends it without a refund.",
  "Illegal proposals are rejected; read the rejections and do not repeat them.",
].join("\n");

function factsPrompt(facts: Facts): string {
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
    `Rejections so far: ${facts.rejections.map((r) => `${r.proposal}: ${r.reason}`).join("; ") || "(none)"}`,
    `Turn ${facts.turn} of ${MAX_TURNS}.`,
  ].join("\n");
}

const deskSetup = setupAgent({
  schemas: refundDeskSchemas,
  models,
  actors: unboundActors,
});

type Rejection = z.infer<typeof rejectionSchema>;

function line(context: DeskContext, text: string): string[] {
  return [...context.trail, `turn ${context.turn}: ${text}`];
}

export const refundDeskMachine = deskSetup.createMachine({
  id: "refund-desk",
  context: ({ input }) => ({
    ticket: input.ticket,
    customerId: input.customerId,
    identityVerified: false,
    order: null,
    approved: false,
    orderIdCandidates: findOrderIds(input.ticket),
    customerReplies: [],
    rejections: [],
    turn: 0,
    approvalThreshold: APPROVAL_THRESHOLD,
    pendingProposal: null,
    identityClaim: "",
    identityAttempts: 0,
    stopReason: "",
    notice: "New ticket.",
    trail: [],
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
                trail: line(context, "turn budget spent -> escalated"),
              },
            }
          : // The turn is counted on the way in (not in `deciding`'s entry) so
            // the decide invoke's input already carries this turn's number.
            { target: "deciding", context: { turn: context.turn + 1 } },
    },
    deciding: {
      invoke: {
        src: "agent.decide",
        input: ({ context }) => {
          const facts = toFacts(context);
          return {
            ...facts,
            model: "desk" as const,
            system: DESK_SYSTEM_PROMPT,
            prompt: factsPrompt(facts),
            allowedEvents: PROPOSALS,
            // MAX_REJECTIONS attempts in all: the third rejection escalates.
            maxRetries: MAX_REJECTIONS - 1,
          };
        },
        onError: ({ context, event }) => {
          const attempts: DecisionAttempt[] =
            event.error instanceof AgentDecisionExhaustedError ? event.error.attempts : [];
          const rejections: Rejection[] = attempts.map((attempt) => ({
            proposal: attempt.event?.type ?? "(none)",
            reason:
              (attempt.event ? proposalBlocker(context, attempt.event) : undefined) ??
              attempt.reason,
          }));
          return {
            target: "escalated",
            context: {
              rejections: [...context.rejections, ...rejections],
              stopReason: "decider exhausted",
              notice: "Escalated: the decider kept proposing illegal steps.",
              trail: line(
                context,
                `decider exhausted after ${attempts.length} rejected proposal(s) -> escalated`,
              ),
            },
          };
        },
      },
      on: {
        // Each transition returns undefined when illegal; the runtime records
        // the rejection on the decision request and asks again.
        VERIFY_IDENTITY: ({ context }) =>
          verifyBlocker(context)
            ? undefined
            : {
                target: "askingIdentity",
                context: {
                  pendingProposal: { type: "VERIFY_IDENTITY" },
                  notice: "Asked the customer to confirm their identity.",
                  trail: line(context, "VERIFY_IDENTITY"),
                },
              },
        LOOKUP_ORDER: ({ context, event }) => ({
          target: "lookingUp",
          context: {
            pendingProposal: { type: "LOOKUP_ORDER", orderId: event.orderId },
            notice: `Looking up ${event.orderId}.`,
            trail: line(context, `LOOKUP_ORDER ${event.orderId}`),
          },
        }),
        ASK_CUSTOMER: ({ context, event }) => ({
          target: "askingCustomer",
          context: {
            pendingProposal: { type: "ASK_CUSTOMER", text: event.question },
            notice: event.question,
            trail: line(context, `ASK_CUSTOMER "${event.question}"`),
          },
        }),
        REQUEST_APPROVAL: ({ context, event }) =>
          approvalBlocker(context, event.amount)
            ? undefined
            : {
                target: "approving",
                context: {
                  pendingProposal: { type: "REQUEST_APPROVAL", amount: event.amount },
                  notice: `Approve a refund of $${event.amount} on ${context.order?.id ?? "the order"}?`,
                  trail: line(context, `REQUEST_APPROVAL $${event.amount}`),
                },
              },
        ISSUE_REFUND: ({ context, event }) =>
          issueBlocker(context, event.amount)
            ? undefined
            : {
                target: "checkingIssue",
                context: {
                  pendingProposal: { type: "ISSUE_REFUND", amount: event.amount },
                  notice: `Issuing $${event.amount}.`,
                  trail: line(context, `ISSUE_REFUND $${event.amount}`),
                },
              },
        ESCALATE: ({ context, event }) => ({
          target: "escalated",
          context: {
            stopReason: event.reason,
            notice: `Escalated: ${event.reason}`,
            trail: line(context, `ESCALATE (${event.reason})`),
          },
        }),
        CLOSE: ({ context, event }) => ({
          target: "closed",
          context: {
            stopReason: event.reason,
            notice: `Closed: ${event.reason}`,
            trail: line(context, `CLOSE (${event.reason})`),
          },
        }),
      },
    },
    askingIdentity: {
      tags: ["waiting"],
      meta: {
        interaction: {
          label: "Please confirm your identity (email and one order detail).",
          textEvent: "IDENTITY_CLAIM",
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
        src: "verifyIdentity",
        input: ({ context }) => ({ customerId: context.customerId, claim: context.identityClaim }),
        onDone: ({ context, output }) =>
          output
            ? {
                target: "checkingBudget",
                context: {
                  identityVerified: true,
                  notice: "Identity verified.",
                  trail: line(context, "identity verified"),
                },
              }
            : {
                target: "checkingBudget",
                context: {
                  identityAttempts: context.identityAttempts + 1,
                  rejections: [
                    ...context.rejections,
                    { proposal: "VERIFY_IDENTITY", reason: "identity check failed" },
                  ],
                  notice: "Identity check failed.",
                  trail: line(context, "identity check failed"),
                },
              },
        onError: ({ context }) => ({
          target: "escalated",
          context: {
            stopReason: "identity service failed",
            notice: "Escalated: the identity check errored.",
            trail: line(context, "identity check errored -> escalated"),
          },
        }),
      },
    },
    lookingUp: {
      invoke: {
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
                  notice: `Loaded ${order.id}.`,
                  trail: line(
                    context,
                    `${order.id} found ($${order.total}, ${order.customerId}${order.refunded ? ", refunded" : ""})`,
                  ),
                },
              }
            : {
                target: "checkingBudget",
                context: {
                  order: null,
                  rejections: [
                    ...context.rejections,
                    { proposal: "LOOKUP_ORDER", reason: `order ${orderId} not found` },
                  ],
                  notice: `Order ${orderId} not found.`,
                  trail: line(context, `order ${orderId} not found`),
                },
              };
        },
        onError: ({ context }) => ({
          target: "escalated",
          context: {
            stopReason: "order lookup failed",
            notice: "Escalated: the order lookup errored.",
            trail: line(context, "order lookup errored -> escalated"),
          },
        }),
      },
    },
    askingCustomer: {
      tags: ["waiting"],
      meta: {
        interaction: {
          label: "{notice}",
          textEvent: "CUSTOMER_REPLY",
          events: { CUSTOMER_REPLY: { label: "Reply" } },
        },
      },
      on: {
        CUSTOMER_REPLY: ({ context, event }) => {
          // explorePaths/canReach deliver external events by type alone, so
          // the payload may be missing there; a live host always sends one.
          const reply = typeof event.reply === "string" ? event.reply : "";
          return {
            target: "checkingBudget",
            context: {
              customerReplies: [...context.customerReplies, reply],
              orderIdCandidates: [
                ...new Set([...context.orderIdCandidates, ...findOrderIds(reply)]),
              ],
              notice: "The customer replied.",
              trail: line(context, `customer replied "${reply}"`),
            },
          };
        },
      },
    },
    approving: {
      tags: ["waiting"],
      meta: {
        interaction: {
          label: "{notice}",
          textEvent: "REJECT",
          events: {
            APPROVE: { label: "Approve refund", style: "primary" },
            REJECT: { label: "Reject refund", style: "danger" },
          },
        },
      },
      on: {
        // The only writer of `approved`.
        APPROVE: ({ context }) => ({
          target: "checkingBudget",
          context: {
            approved: true,
            notice: "A human approved the refund.",
            trail: line(context, `approved $${context.pendingProposal?.amount ?? 0}`),
          },
        }),
        REJECT: ({ context, event }) => ({
          target: "closed",
          context: {
            stopReason: `approver rejected: ${event.reason}`,
            notice: `Closed: the approver rejected the refund (${event.reason}).`,
            trail: line(context, `approver rejected (${event.reason}) -> closed`),
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
          (amount <= context.approvalThreshold || context.approved);
        return legal
          ? { target: "issuing" }
          : {
              target: "illegallyIssued",
              context: { trail: line(context, "INVARIANT VIOLATED -> illegallyIssued") },
            };
      },
    },
    issuing: {
      invoke: {
        src: "issueRefund",
        input: ({ context }) => ({
          orderId: context.order?.id ?? "",
          amount: context.pendingProposal?.amount ?? 0,
          identityVerified: context.identityVerified,
          approved: context.approved,
        }),
        onDone: ({ context }) => ({
          target: "issued",
          context: {
            notice: `Refunded $${context.pendingProposal?.amount ?? 0}.`,
            trail: line(context, `refund issued`),
          },
        }),
        onError: ({ context }) => ({
          target: "escalated",
          context: {
            stopReason: "payout failed",
            notice: "Escalated: the payout errored.",
            trail: line(context, "payout errored -> escalated"),
          },
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
        trail: context.trail,
      }),
    },
    closed: {
      type: "final",
      output: ({ context }) => ({
        summary: `Closed without a refund: ${context.stopReason}.`,
        outcome: "close" as const,
        turns: context.turn,
        rejections: context.rejections.length,
        trail: context.trail,
      }),
    },
    escalated: {
      type: "final",
      output: ({ context }) => ({
        summary: `Escalated to a person: ${context.stopReason}.`,
        outcome: "escalate" as const,
        turns: context.turn,
        rejections: context.rejections.length,
        trail: context.trail,
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
        trail: context.trail,
      }),
    },
  },
});

export type DeskSnapshot = SnapshotFrom<typeof refundDeskMachine>;
type DeskEvent = Parameters<typeof refundDeskMachine.transition>[1];

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

type Counters = () => { modelCalls: number; judgeCalls: number };

/**
 * Runs one scenario through the desk against a fresh world, answering idle
 * waits from the world's script, and returns the episode's metrics.
 */
export async function runDeskEpisode(
  scenario: Scenario,
  options: { decide: AgentDecisionExecutor; counters?: Counters },
): Promise<EpisodeMetrics> {
  const world = createWorld(scenario);
  // Copy: a caller may hand back its live counter object, which would otherwise read the same at the end.
  const start = { ...(options.counters?.() ?? { modelCalls: 0, judgeCalls: 0 }) };
  const trail: string[] = [];
  let machineTrailSeen = 0;
  const syncTrail = (context: DeskContext) => {
    for (; machineTrailSeen < context.trail.length; machineTrailSeen++) {
      trail.push(context.trail[machineTrailSeen]!);
    }
  };

  // Rejected attempts the decider was shown, per decide invoke. A new invoke
  // starts with empty `attempts`, which commits the previous invoke's count.
  let committedRejections = 0;
  let currentAttempts: DecisionAttempt[] = [];
  const decide: AgentDecisionExecutor = (request, info) => {
    if (request.attempts.length === 0) {
      committedRejections += currentAttempts.length;
      currentAttempts = [];
    }
    const facts = factsSchema.safeParse(request.input);
    for (const attempt of request.attempts.slice(currentAttempts.length)) {
      const reason =
        (attempt.event && facts.success ? proposalBlocker(facts.data, attempt.event) : undefined) ??
        attempt.reason;
      const turn = facts.success ? facts.data.turn : "?";
      const label = attempt.event ? describeProposal(attempt.event) : "(no proposal)";
      trail.push(`turn ${turn}: ${label} rejected: ${reason}`);
    }
    currentAttempts = request.attempts;
    return options.decide(request, info);
  };

  const runtimeOptions = {
    executors: { decide },
    actors: createWorldActors(world),
    onTransition: (snapshot: DeskSnapshot) => syncTrail(snapshot.context),
  };

  let result = await runToQuiescence(createAgentRuntime(refundDeskMachine, runtimeOptions), {
    input: { ticket: scenario.ticket, customerId: scenario.customerId },
  });
  while (result.status === "idle") {
    syncTrail(result.snapshot.context);
    const event = answerFromWorld(result.snapshot, world);
    result = await runToQuiescence(createAgentRuntime(refundDeskMachine, runtimeOptions), {
      snapshot: result.persist(),
      event,
    });
  }
  if (result.status !== "done") {
    throw new Error(`refund desk: episode ${scenario.id} ended with status ${result.status}`);
  }
  syncTrail(result.snapshot.context);

  const exhausted = result.snapshot.context.stopReason === "decider exhausted";
  const decisionRejections = committedRejections + (exhausted ? 0 : currentAttempts.length);
  const end = { ...(options.counters?.() ?? start) };
  const outcome: Outcome = result.output.outcome;
  return {
    scenarioId: scenario.id,
    outcome,
    correct: outcome === scenario.expected,
    turns: result.output.turns,
    modelCalls: end.modelCalls - start.modelCalls,
    judgeCalls: end.judgeCalls - start.judgeCalls,
    rejections: decisionRejections + result.output.rejections,
    violations: world.violations,
    trail,
  };
}

/** A benchmark arm: the frozen desk with a pluggable decider. */
export function createDeskArm(options: {
  label: string;
  decide: AgentDecisionExecutor;
  counters?: Counters;
}): Arm {
  return {
    label: options.label,
    runEpisode: (scenario) =>
      runDeskEpisode(scenario, {
        decide: options.decide,
        ...(options.counters ? { counters: options.counters } : {}),
      }),
  };
}
