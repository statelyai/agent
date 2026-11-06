/**
 * Fake effects: a scripted stand-in for the model, an in-memory order table,
 * and write logs. Fresh per run, so a test can read what was written.
 */
import type { Classification, GenerateRequest, Order, SupportEffects } from "./before.js";

export const ORDERS: Order[] = [
  { orderId: "A-100", total: 20, status: "shipped" },
  { orderId: "A-200", total: 240, status: "processing" },
];

export interface FakeWorld {
  effects: SupportEffects;
  refunds: Array<{ orderId: string; amount: number }>;
  escalations: Array<{ ticketId: string; reason: string }>;
}

/** Reads the ticket the way a structured-output model would, deterministically. */
function classify(message: string): Classification {
  const orderId = /\b[A-Z]-\d+\b/.exec(message)?.[0] ?? null;
  const amount = /\$(\d+)/.exec(message)?.[1];
  const intent = /refund|money back/i.test(message)
    ? "refund"
    : /where|status|ship/i.test(message)
      ? "status"
      : "other";
  return { intent, orderId, amount: amount === undefined ? null : Number(amount) };
}

/**
 * `flakyClassify`: how many classify calls fail with a 503 before one
 * succeeds. At `MAX_ATTEMPTS` or more, the workflow gives up on the model.
 */
export function createFakeWorld(options: { flakyClassify?: number } = {}): FakeWorld {
  let failures = options.flakyClassify ?? 0;
  const refunds: FakeWorld["refunds"] = [];
  const refundIds = new Map<string, string>();
  const escalations: FakeWorld["escalations"] = [];
  const effects: SupportEffects = {
    // One model behind two structured-output tasks.
    generate: async (request) => {
      if (request.task === "reply") {
        const { facts } = request as unknown as GenerateRequest<"reply">;
        return { text: `Thanks for writing in. ${facts}` } as never;
      }
      if (failures > 0) {
        failures--;
        throw Object.assign(new Error("model overloaded"), { status: 503 });
      }
      return classify(request.ticket) as never;
    },
    lookupOrder: async (orderId) => ORDERS.find((order) => order.orderId === orderId) ?? null,
    // A real provider deduplicates on the key; so does the fake.
    issueRefund: async (orderId, amount, idempotencyKey) => {
      const issued = refundIds.get(idempotencyKey);
      if (issued) return { refundId: issued };
      refunds.push({ orderId, amount });
      const refundId = `rf_${orderId}_${refunds.length}`;
      refundIds.set(idempotencyKey, refundId);
      return { refundId };
    },
    escalate: async (ticketId, reason) => {
      escalations.push({ ticketId, reason });
      return { queue: "tier-2" };
    },
  };
  return { effects, refunds, escalations };
}
