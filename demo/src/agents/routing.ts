/**
 * Intent routing — the model picks one typed event; the machine owns every
 * destination.
 *
 * What the MODEL owns: choosing exactly one of the legal events
 * (`BILLING` / `TECHNICAL` / `ACCOUNT` / `UNCLEAR`) via `agent.decide`.
 * What the MACHINE owns: where each event goes. There are no application-level
 * `if (category === ...)` conditionals — the routing table IS the state
 * machine's `on` block, and an event the model invents can't type-check into it.
 */
import { z } from "zod";
import { setupAgent } from "@statelyai/agent";

const reasonSchema = z
  .string()
  .describe("One short sentence naming the signals in the request that justify this queue.");

const agentSetup = setupAgent({
  context: z.object({
    query: z.string(),
    queue: z.string().nullable(),
    reason: z.string().nullable(),
  }),
  input: z.object({ query: z.string() }),
  output: z.object({ queue: z.string(), reason: z.string() }),
  // Every route carries the WHY: the model must justify its pick, and the
  // justification is typed payload, not prose the machine has to parse.
  events: {
    BILLING: z.object({ reason: reasonSchema }),
    TECHNICAL: z.object({ reason: reasonSchema }),
    ACCOUNT: z.object({ reason: reasonSchema }),
    UNCLEAR: z.object({ reason: reasonSchema }),
  },
});

function routed(
  context: { queue: string | null; reason: string | null },
  fallback: string,
): { queue: string; reason: string } {
  return { queue: context.queue ?? fallback, reason: context.reason ?? "No reason given." };
}

export const routingMachine = agentSetup.createMachine({
  id: "routing",
  context: ({ input }) => ({ query: input.query, queue: null, reason: null }),
  initial: "classifying",
  states: {
    classifying: {
      invoke: {
        src: "agent.decide",
        input: ({ context }) => ({
          model: "router",
          system:
            "Route the support request. BILLING for charges, payments, or invoices; " +
            "TECHNICAL for product failures and errors; ACCOUNT for login or profile " +
            "access; UNCLEAR when there is not enough information.",
          prompt: context.query,
          allowedEvents: ["BILLING", "TECHNICAL", "ACCOUNT", "UNCLEAR"],
        }),
      },
      // Static targets — the machine, not the model, owns each queue. The
      // model only supplies the justification it must carry on the event.
      on: {
        BILLING: ({ event }) => ({
          target: "billingQueue",
          context: { queue: "billing", reason: event.reason },
        }),
        TECHNICAL: ({ event }) => ({
          target: "technicalQueue",
          context: { queue: "technical", reason: event.reason },
        }),
        ACCOUNT: ({ event }) => ({
          target: "accountQueue",
          context: { queue: "account", reason: event.reason },
        }),
        UNCLEAR: ({ event }) => ({
          target: "needsClarification",
          context: { queue: "unclear", reason: event.reason },
        }),
      },
    },
    billingQueue: { type: "final", output: ({ context }) => routed(context, "billing") },
    technicalQueue: { type: "final", output: ({ context }) => routed(context, "technical") },
    accountQueue: { type: "final", output: ({ context }) => routed(context, "account") },
    needsClarification: { type: "final", output: ({ context }) => routed(context, "unclear") },
  },
});
