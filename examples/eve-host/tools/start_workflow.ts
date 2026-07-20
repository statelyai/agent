/**
 * Eve tool `start_workflow` (filename = model-facing name). Starts the refund
 * state machine and runs it to its first pause. Returns a JSON-safe result the
 * model can reason over: a `handle` to resume later plus the typed interaction
 * to present, or the final outcome if the machine ran straight to done.
 *
 * The machine owns legality/state; this tool is a thin bridge over `runAgent`.
 */
import { z } from "zod";
import { defineTool } from "../eve-shims.js";
import { startRefund } from "../machine.js";

export default defineTool({
  description:
    "Start a refund workflow for an order. Returns { status } — 'pending' with a " +
    "handle + interaction to show the user, or 'done' with the outcome.",
  inputSchema: z.object({
    amount: z.number().describe("Refund amount in USD"),
    orderId: z.string().describe("Order ID, e.g. ord-1234"),
  }),
  async execute({ amount, orderId }) {
    return startRefund({ amount, orderId });
  },
});
