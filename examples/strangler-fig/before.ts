/**
 * BEFORE: a support-ticket workflow as it ships today. One async function,
 * every side effect behind an `effects` object (the only change a strangler-fig
 * retrofit asks of it), and every rule inline: a retry around the classifier,
 * a refund limit as an `if`, an escalation for anything it does not know.
 */

export interface Ticket {
  id: string;
  message: string;
}

export interface Order {
  orderId: string;
  total: number;
  status: "processing" | "shipped";
}

export interface Classification {
  intent: "refund" | "status" | "other";
  orderId: string | null;
  amount: number | null;
}

/** What each `generate` task answers: a model behind a structured-output call. */
export interface GenerateTasks {
  classify: { ticket: string; result: Classification };
  reply: { ticket: string; facts: string; result: { text: string } };
}

export type GenerateRequest<TTask extends keyof GenerateTasks> = { task: TTask } & Omit<
  GenerateTasks[TTask],
  "result"
>;

export interface SupportEffects {
  generate<TTask extends keyof GenerateTasks>(
    request: GenerateRequest<TTask>,
  ): Promise<GenerateTasks[TTask]["result"]>;
  lookupOrder(orderId: string): Promise<Order | null>;
  /** `idempotencyKey` makes a retried or resumed run's second call a no-op. */
  issueRefund(
    orderId: string,
    amount: number,
    idempotencyKey: string,
  ): Promise<{ refundId: string }>;
  escalate(ticketId: string, reason: string): Promise<{ queue: string }>;
}

export interface SupportResult {
  outcome: "refunded" | "answered" | "escalated";
  reply: string;
  refundId: string | null;
}

/** Classifier attempts before giving up on the model. */
export const MAX_ATTEMPTS = 3;
/** Refunds above this go to a person. */
export const REFUND_LIMIT = 100;

/** The classify phase: a retry loop around a flaky model call. */
export async function classifyTicket(
  ticket: Ticket,
  effects: SupportEffects,
): Promise<Classification> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await effects.generate({ task: "classify", ticket: ticket.message });
    } catch {
      // A 503 from the provider: try again.
    }
  }
  // Out of attempts: hand the ticket to a person.
  return { intent: "other", orderId: null, amount: null };
}

async function escalate(ticket: Ticket, reason: string, effects: SupportEffects) {
  const { queue } = await effects.escalate(ticket.id, reason);
  return {
    outcome: "escalated" as const,
    reply: `A teammate from ${queue} will follow up (${reason}).`,
    refundId: null,
  };
}

/** Everything after classification: lookups, the refund rules, the reply. */
export async function resolveTicket(
  ticket: Ticket,
  classification: Classification,
  effects: SupportEffects,
): Promise<SupportResult> {
  if (classification.intent === "other" || classification.orderId === null) {
    return escalate(ticket, "unclassified", effects);
  }
  const order = await effects.lookupOrder(classification.orderId);
  if (!order) return escalate(ticket, "order not found", effects);

  if (classification.intent === "status") {
    const { text } = await effects.generate({
      task: "reply",
      ticket: ticket.message,
      facts: `Order ${order.orderId} is ${order.status}.`,
    });
    return { outcome: "answered", reply: text, refundId: null };
  }

  const amount = classification.amount ?? order.total;
  if (amount > order.total) return escalate(ticket, "refund over order total", effects);
  if (amount > REFUND_LIMIT) return escalate(ticket, "refund needs approval", effects);
  const { refundId } = await effects.issueRefund(order.orderId, amount, `refund:${ticket.id}`);
  const { text } = await effects.generate({
    task: "reply",
    ticket: ticket.message,
    facts: `Refunded $${amount} on ${order.orderId} (${refundId}).`,
  });
  return { outcome: "refunded", reply: text, refundId };
}

/** The whole workflow: classify, then resolve. */
export async function runTicket(ticket: Ticket, effects: SupportEffects): Promise<SupportResult> {
  const classification = await classifyTicket(ticket, effects);
  return resolveTicket(ticket, classification, effects);
}
