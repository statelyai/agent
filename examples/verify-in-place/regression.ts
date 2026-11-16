/**
 * A SEEDED REGRESSION: `before.ts` after a plausible change. Someone added a
 * shortcut so repeat customers skip approval on refunds up to twice the
 * threshold. Every test of the happy path still passes; the model's approval
 * rule does not. The conformance check catches it on a recorded run.
 */
import {
  APPROVAL_THRESHOLD,
  MAX_DECISIONS,
  type RefundEffects,
  type RefundOutcome,
} from "./before.js";

export async function handleRefundRequestRegressed(
  fx: RefundEffects,
  request: { orderId: string; message: string; repeatCustomer?: boolean },
): Promise<RefundOutcome> {
  const order = await fx.lookupOrder(request.orderId);
  for (let decisions = 0; decisions < MAX_DECISIONS; decisions++) {
    const decision = await fx.decide({ request: request.message, order, decisions });
    if (decision.type === "reply") return "replied";
    if (decision.type === "investigate") continue;
    if (decision.amount > order.total) return "over-total";
    // The change: repeat customers get a higher approval limit.
    const limit = request.repeatCustomer ? APPROVAL_THRESHOLD * 2 : APPROVAL_THRESHOLD;
    if (decision.amount > limit) {
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
