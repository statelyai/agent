/**
 * THE MODEL: the refund agent's control flow as a machine, kept in the repo
 * next to the code. Its actors are placeholders, so the model runs none of the
 * code. It is proved with `canReach` and checked against recorded runs of
 * `before.ts` with `checkConformance`.
 *
 * Each rule of the code is a state or a guard here:
 *   - `awaitingApproval` is the only way to a refund over the threshold,
 *   - a refund over the order total ends in `overTotal`, never `refunding`,
 *   - `deciding` runs at most MAX_DECISIONS times.
 */
import { createAsyncLogic } from "xstate";
import { z } from "zod";
import { setupAgent } from "@statelyai/agent";
import { APPROVAL_THRESHOLD, MAX_DECISIONS } from "./before.js";

const orderSchema = z.object({ orderId: z.string(), total: z.number() });
const decisionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("refund"), amount: z.number() }),
  z.object({ type: z.literal("reply"), message: z.string() }),
  z.object({ type: z.literal("investigate") }),
]);

/** An actor the model names but never runs: `checkConformance` answers it from a recording. */
const placeholder = <T>(output: z.ZodType<T>) =>
  createAsyncLogic({
    schemas: { output },
    run: (): Promise<T> => Promise.reject(new Error("model only: answered from a recording")),
  });

export const refundModel = setupAgent({
  input: z.object({ orderId: z.string() }),
  context: z.object({
    orderId: z.string(),
    order: orderSchema.nullable(),
    decisions: z.number(),
    amount: z.number(),
    approved: z.boolean(),
  }),
  events: { APPROVE: {}, REJECT: {} },
  actors: {
    lookupOrder: placeholder(orderSchema),
    decide: placeholder(decisionSchema),
    issueRefund: placeholder(z.undefined()),
  },
}).createMachine({
  id: "refund",
  context: ({ input }) => ({
    orderId: input.orderId,
    order: null,
    decisions: 0,
    amount: 0,
    approved: false,
  }),
  initial: "lookingUp",
  states: {
    lookingUp: {
      invoke: {
        src: "lookupOrder",
        input: ({ context }) => context.orderId,
        onDone: ({ event }) => ({ target: "checking", context: { order: event.output } }),
      },
    },
    checking: {
      type: "choice",
      choice: ({ context }) =>
        context.decisions < MAX_DECISIONS ? { target: "deciding" } : { target: "escalated" },
    },
    deciding: {
      invoke: {
        src: "decide",
        input: ({ context }) => ({ decisions: context.decisions }),
        onDone: ({ context, event }) => {
          const decision = event.output;
          const decisions = context.decisions + 1;
          if (decision.type === "reply") return { target: "replied", context: { decisions } };
          if (decision.type === "investigate")
            return { target: "checking", context: { decisions } };
          const amount = decision.amount;
          if (amount > context.order!.total)
            return { target: "overTotal", context: { decisions, amount } };
          return amount > APPROVAL_THRESHOLD
            ? { target: "awaitingApproval", context: { decisions, amount } }
            : { target: "refunding", context: { decisions, amount } };
        },
      },
    },
    awaitingApproval: {
      on: {
        APPROVE: { target: "refunding", context: { approved: true } },
        REJECT: { target: "declined" },
      },
    },
    refunding: {
      invoke: {
        src: "issueRefund",
        input: ({ context }) => ({ orderId: context.orderId, amount: context.amount }),
        onDone: { target: "refunded" },
      },
    },
    refunded: { type: "final", output: () => ({ outcome: "refunded" as const }) },
    replied: { type: "final", output: () => ({ outcome: "replied" as const }) },
    declined: { type: "final", output: () => ({ outcome: "declined" as const }) },
    escalated: { type: "final", output: () => ({ outcome: "escalated" as const }) },
    overTotal: { type: "final", output: () => ({ outcome: "over-total" as const }) },
  },
});
