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

const agentSetup = setupAgent({
  context: z.object({ query: z.string(), queue: z.string().nullable() }),
  input: z.object({ query: z.string() }),
  output: z.object({ queue: z.string() }),
  events: {
    BILLING: z.object({}),
    TECHNICAL: z.object({}),
    ACCOUNT: z.object({}),
    UNCLEAR: z.object({}),
  },
});

export const routingMachine = agentSetup.createMachine({
  id: "routing",
  context: ({ input }) => ({ query: input.query, queue: null }),
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
      // Static targets — the machine, not the model, owns each queue.
      on: {
        BILLING: { target: "billingQueue", context: { queue: "billing" } },
        TECHNICAL: { target: "technicalQueue", context: { queue: "technical" } },
        ACCOUNT: { target: "accountQueue", context: { queue: "account" } },
        UNCLEAR: { target: "needsClarification", context: { queue: "unclear" } },
      },
    },
    billingQueue: { type: "final", output: ({ context }) => ({ queue: context.queue ?? "billing" }) },
    technicalQueue: { type: "final", output: ({ context }) => ({ queue: context.queue ?? "technical" }) },
    accountQueue: { type: "final", output: ({ context }) => ({ queue: context.queue ?? "account" }) },
    needsClarification: { type: "final", output: ({ context }) => ({ queue: context.queue ?? "unclear" }) },
  },
});
