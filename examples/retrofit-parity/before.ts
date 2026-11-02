/**
 * BEFORE: a hand-rolled AI SDK refund loop, the code `index.ts` ports.
 *
 * Two tools and one approval:
 *   - `lookupOrder` runs inside `generateText`, like any AI SDK tool.
 *   - `issueRefund` is offered to the model without its `execute`, so the call
 *     comes back to the loop, which asks a person and only then runs it.
 *
 * The loop asks for approval on every refund, and checks the refund against
 * the order total only through the system prompt.
 *
 * The model and tools are parameters, so a test can pass a stand-in model and
 * a recorder can wrap both.
 */
import {
  generateText,
  stepCountIs,
  tool,
  type LanguageModel,
  type ModelMessage,
  type Tool,
} from "ai";
import { z } from "zod";

export const orderSchema = z.object({ orderId: z.string(), total: z.number() });
export type Order = z.infer<typeof orderSchema>;

export const refundSchema = z.object({ orderId: z.string(), amount: z.number() });
export type Refund = z.infer<typeof refundSchema>;

/** The world the tools change: ground truth for parity. */
export interface World {
  orders: Record<string, Order>;
  refunds: Refund[];
  /** Every refund a person was asked to approve. */
  approvals: Refund[];
}

export function createWorld(orders: Order[]): World {
  return {
    orders: Object.fromEntries(orders.map((order) => [order.orderId, order])),
    refunds: [],
    approvals: [],
  };
}

export type SupportTools = {
  lookupOrder: Tool<{ orderId: string }, Order | { found: false }>;
  issueRefund: Tool<Refund, { refundId: string }>;
};

export function createTools(world: World): SupportTools {
  return {
    lookupOrder: tool({
      description: "Look up an order by id.",
      inputSchema: z.object({ orderId: z.string() }),
      execute: async ({ orderId }): Promise<Order | { found: false }> =>
        world.orders[orderId] ?? { found: false },
    }),
    issueRefund: tool({
      description: "Refund part or all of an order.",
      inputSchema: refundSchema,
      execute: async (refund: Refund) => {
        world.refunds.push(refund);
        return { refundId: `rf_${refund.orderId}` };
      },
    }),
  };
}

export interface RefundRequest {
  ticket: string;
  model: LanguageModel;
  tools: SupportTools;
  approve: (refund: Refund) => Promise<boolean>;
}

/** Every way the loop returns. */
export interface RefundResult {
  outcome: "answered" | "refunded" | "declined" | "step-limit";
  reply: string;
}

export const SYSTEM =
  "You are a refund agent. Look up the order first. Never refund more than the order total.";
export const MAX_STEPS = 6;

export async function runRefundLoop({
  ticket,
  model,
  tools,
  approve,
}: RefundRequest): Promise<RefundResult> {
  const messages: ModelMessage[] = [{ role: "user", content: ticket }];
  // The model sees `issueRefund`, but the loop runs it after approval.
  const { execute: issueRefund, ...refundSpec } = tools.issueRefund;

  for (let step = 0; step < MAX_STEPS; step++) {
    const { text, toolCalls, response } = await generateText({
      model,
      system: SYSTEM,
      messages,
      tools: { lookupOrder: tools.lookupOrder, issueRefund: refundSpec },
      stopWhen: stepCountIs(1),
    });
    messages.push(...response.messages);

    const refundCall = toolCalls.find((call) => call.toolName === "issueRefund");
    if (!refundCall) {
      if (toolCalls.length === 0) return { outcome: "answered", reply: text };
      continue; // lookupOrder ran; its result is in `messages`
    }
    const refund = refundSchema.parse(refundCall.input);
    if (!(await approve(refund))) return { outcome: "declined", reply: "Refund declined." };
    await issueRefund!(refund, { toolCallId: refundCall.toolCallId, messages, context: {} });
    return { outcome: "refunded", reply: `Refunded $${refund.amount} on ${refund.orderId}.` };
  }
  return { outcome: "step-limit", reply: "" };
}
