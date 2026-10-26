/**
 * Test doubles for this example's deciders. Tests only; nothing here is
 * exported from index.ts.
 *
 *   - `eagerChoice`: a examples/mock-model.ts decision entry, a plausible
 *     eager model for arm B and playbook v0.
 *   - `jevJudge`: examples/mock-judge.ts answering the closed choice by label
 *     (an option id), and `isRefundRequest` for the playbook's classifier.
 *   - `requestAt`: the real desk's `decideNext` request at a probe state.
 */
import type {
  AgentDecisionExecutor,
  AgentDecisionRequest,
  AgentExecutorDecisionRequest,
  ChosenEvent,
  DecisionAttempt,
} from "@statelyai/agent";
import { createMockJudge } from "../mock-judge.js";
import type { MockDecisionEntry } from "../mock-model.js";
import { APPROVAL_THRESHOLD, type Facts, type Order } from "./contract.js";
import { decideDeskStep, deskSnapshotAt, factsOf } from "./desk.js";

/** A refund request unless it asks about something else (shipping, delivery, tracking). */
export const isRefundTicket = (text: string) =>
  /refund|money back|\$\d+ back/i.test(text) && !/shipping address/i.test(text);

/** The event of the option whose id is `id` (ids as `decisionOptionIds` builds them). */
const optionId = (event: ChosenEvent) =>
  Object.entries(event)
    .filter(([key]) => key !== "type")
    .reduce((id, [, value]) => `${id}:${String(value)}`, event.type);

/**
 * The right step for the sample world, chosen among `events`: look up, verify,
 * check owner and refund status, then approve or pay; close or escalate when a
 * rule says so.
 */
export function rightChoice(facts: Facts, events: ChosenEvent[]): ChosenEvent {
  const find = (type: string, reason?: string) =>
    events.find(
      (event) =>
        event.type === type &&
        (reason === undefined || (event as { reason?: string }).reason === reason),
    );
  const pick = (type: string, reason?: string) => {
    const event = find(type, reason);
    if (!event) throw new Error(`rightChoice: ${type} ${reason ?? ""} is not offered`);
    return event;
  };
  if (!facts.order) {
    if (facts.rejections.some((r) => r.proposal === "LOOKUP_ORDER")) {
      return pick("ESCALATE", "order not found");
    }
    if (facts.orderIdCandidates.length) return pick("LOOKUP_ORDER");
    if (facts.customerReplies.length === 0) return pick("ASK_CUSTOMER");
    return pick("ESCALATE", "needs a person");
  }
  if (facts.order.customerId !== facts.customerId) {
    return pick("ESCALATE", "order belongs to another customer");
  }
  if (facts.order.refunded) return pick("CLOSE", "order already refunded");
  if (!isRefundTicket([facts.ticket, ...facts.customerReplies].join(" "))) {
    return pick("CLOSE", "not a refund request");
  }
  if (!facts.identityVerified) {
    return facts.rejections.some((r) => r.proposal === "VERIFY_IDENTITY")
      ? pick("ESCALATE", "identity could not be verified")
      : pick("VERIFY_IDENTITY");
  }
  return find("REQUEST_APPROVAL") ?? pick("ISSUE_REFUND");
}

/** A plain-function decider that takes the right offered option. */
export const rightPath: AgentDecisionExecutor = async (request) => ({
  event: rightChoice(
    factsOf(request),
    (request.options ?? []).map(({ event }) => event),
  ),
});

/**
 * A plausible eager model, as a examples/mock-model.ts decision entry: pay
 * out if it can, else ask for approval, else look up an order, else verify,
 * else ask; it never closes a ticket on its own.
 */
export const eagerChoice = ((request: AgentDecisionRequest) => {
  const events = (request.options ?? []).map(({ event }) => event);
  for (const type of ["ISSUE_REFUND", "REQUEST_APPROVAL", "LOOKUP_ORDER", "VERIFY_IDENTITY"]) {
    const event = events.find((candidate) => candidate.type === type);
    if (event) return event;
  }
  return events.find((event) => event.type === "ASK_CUSTOMER") ?? events[0]!;
}) satisfies MockDecisionEntry;

/**
 * A mock Jev: answers the desk's closed choice (`next`) with the right
 * option's label, and the playbook's `isRefundRequest` by keyword.
 */
export function jevJudge() {
  return createMockJudge({
    next: (state, question) => {
      const labels = Object.keys((question as { criteria: Record<string, string> }).criteria);
      const context = (state as { context: unknown }).context;
      const events = labels.map(labelToEvent);
      return optionId(rightChoice(factsOf({ input: { context } }), events));
    },
    isRefundRequest: (state) => {
      const { ticket, customerReplies } = state as { ticket: string; customerReplies: string[] };
      return isRefundTicket([ticket, ...customerReplies].join(" "));
    },
  });
}

/** Rebuilds an option's event from its label (`ISSUE_REFUND:40`, `ESCALATE:order not found`). */
function labelToEvent(label: string): ChosenEvent {
  const [type, ...rest] = label.split(":");
  const value = rest.join(":");
  switch (type) {
    case "LOOKUP_ORDER":
      return { type, orderId: value };
    case "ASK_CUSTOMER":
      return { type, question: value };
    case "REQUEST_APPROVAL":
    case "ISSUE_REFUND":
      return { type, amount: Number(value) };
    case "ESCALATE":
    case "CLOSE":
      return { type, reason: value };
    default:
      return { type: type! };
  }
}

const ORDER: Order = {
  id: "ORD-1001",
  customerId: "C-1",
  total: 40,
  refunded: false,
  item: "USB-C cable",
};

/** Facts for a probe desk state: verified, ORD-1001 loaded, unless overridden. */
export function facts(overrides: Partial<Facts> = {}): Facts {
  return {
    ticket: "Hi, ORD-1001 arrived broken. Can I get my $40 back?",
    customerId: "C-1",
    identityVerified: true,
    order: ORDER,
    approved: false,
    orderIdCandidates: ["ORD-1001"],
    customerReplies: [],
    rejections: [],
    turn: 1,
    approvalThreshold: APPROVAL_THRESHOLD,
    ...overrides,
  };
}
export { ORDER };

/** The request the real desk boundary builds at a probe state, with `attempts` as given. */
export async function requestAt(
  probe: Facts,
  attempts: DecisionAttempt[] = [],
): Promise<AgentExecutorDecisionRequest> {
  const snapshot = deskSnapshotAt({
    ...probe,
    pendingProposal: null,
    identityClaim: "",
    stopReason: "",
    notice: "",
  });
  const { request } = await decideDeskStep(snapshot, {
    decide: async (r) => ({ event: r.options![0]!.event }),
  });
  return { ...request, name: "desk", attempts };
}
