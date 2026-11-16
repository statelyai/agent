/**
 * THE EXISTING CODE: a hand-rolled refund agent. It stays as it is; the
 * verify-in-place track checks it without editing it.
 *
 * Every side effect goes through one `effects` object of async functions:
 *   - `lookupOrder` reads the order,
 *   - `decide` asks the model what to do next,
 *   - `requestApproval` asks a person,
 *   - `issueRefund` moves money.
 *
 * The rules live in `if` statements:
 *   - a refund over APPROVAL_THRESHOLD needs a person's approval,
 *   - a refund never exceeds the order total,
 *   - after MAX_DECISIONS decisions the request escalates.
 */

export const APPROVAL_THRESHOLD = 100;
export const MAX_DECISIONS = 3;

export interface Order {
  orderId: string;
  total: number;
}

export type Decision =
  | { type: "refund"; amount: number }
  | { type: "reply"; message: string }
  | { type: "investigate" };

export interface RefundEffects {
  lookupOrder: (orderId: string) => Promise<Order>;
  decide: (args: { request: string; order: Order; decisions: number }) => Promise<Decision>;
  requestApproval: (args: { orderId: string; amount: number }) => Promise<boolean>;
  issueRefund: (args: { orderId: string; amount: number }) => Promise<void>;
}

export type RefundOutcome = "refunded" | "replied" | "declined" | "escalated" | "over-total";

export async function handleRefundRequest(
  fx: RefundEffects,
  request: { orderId: string; message: string },
): Promise<RefundOutcome> {
  const order = await fx.lookupOrder(request.orderId);
  for (let decisions = 0; decisions < MAX_DECISIONS; decisions++) {
    const decision = await fx.decide({ request: request.message, order, decisions });
    if (decision.type === "reply") return "replied";
    if (decision.type === "investigate") continue;
    if (decision.amount > order.total) return "over-total";
    if (decision.amount > APPROVAL_THRESHOLD) {
      const approved = await fx.requestApproval({
        orderId: order.orderId,
        amount: decision.amount,
      });
      if (!approved) return "declined";
    }
    await fx.issueRefund({ orderId: order.orderId, amount: decision.amount });
    return "refunded";
  }
  return "escalated";
}
