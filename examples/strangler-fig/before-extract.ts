/**
 * BEFORE THE EXTRACT: `runTicket` as one function, the shape it had before
 * the extract-method commit split it into `classifyTicket` and
 * `resolveTicket` (before.ts). The carve in step1.ts calls `resolveTicket`
 * instead of copying these lines into an actor. index.test.ts gates the
 * extract with `checkParity` against this file.
 */
import {
  MAX_ATTEMPTS,
  REFUND_LIMIT,
  type Classification,
  type SupportEffects,
  type SupportResult,
  type Ticket,
} from "./before.js";

export async function runTicketBeforeExtract(
  ticket: Ticket,
  effects: SupportEffects,
): Promise<SupportResult> {
  let classification: Classification = { intent: "other", orderId: null, amount: null };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      classification = await effects.generate({ task: "classify", ticket: ticket.message });
      break;
    } catch {
      // A 503 from the provider: try again.
    }
  }

  const escalate = async (reason: string): Promise<SupportResult> => {
    const { queue } = await effects.escalate(ticket.id, reason);
    return {
      outcome: "escalated",
      reply: `A teammate from ${queue} will follow up (${reason}).`,
      refundId: null,
    };
  };

  if (classification.intent === "other" || classification.orderId === null) {
    return escalate("unclassified");
  }
  const order = await effects.lookupOrder(classification.orderId);
  if (!order) return escalate("order not found");

  if (classification.intent === "status") {
    const { text } = await effects.generate({
      task: "reply",
      ticket: ticket.message,
      facts: `Order ${order.orderId} is ${order.status}.`,
    });
    return { outcome: "answered", reply: text, refundId: null };
  }

  const amount = classification.amount ?? order.total;
  if (amount > order.total) return escalate("refund over order total");
  if (amount > REFUND_LIMIT) return escalate("refund needs approval");
  const { refundId } = await effects.issueRefund(order.orderId, amount, `refund:${ticket.id}`);
  const { text } = await effects.generate({
    task: "reply",
    ticket: ticket.message,
    facts: `Refunded $${amount} on ${order.orderId} (${refundId}).`,
  });
  return { outcome: "refunded", reply: text, refundId };
}
