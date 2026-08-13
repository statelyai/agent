/**
 * Refund guard — the model proposes; policy decides.
 *
 * What the MODEL owns: reading the request and choosing one legal event
 * (`AUTO_REFUND` with an extracted amount, `REVIEW`, or `NEEDS_DETAILS`).
 * What the MACHINE owns: the $100 auto-refund limit. `AUTO_REFUND` never lands
 * on `refunded` directly — it routes through the `checkingLimit` choice state,
 * so the policy, not the model, decides whether an amount can be auto-approved.
 * Over-limit amounts settle idle in `awaitingApproval`, waiting for a human
 * `APPROVE` / `DENY` event.
 *
 * Mirrors the README quickstart, with the amount extracted by the decision
 * (carried on the chosen event) instead of supplied as input.
 */
import { z } from "zod";
import { setupAgent } from "@statelyai/agent";

const agentSetup = setupAgent({
  context: z.object({
    request: z.string(),
    amount: z.number().nullable(),
  }),
  input: z.object({ request: z.string() }),
  output: z.object({
    outcome: z.enum(["refunded", "approved", "denied", "needs-details"]),
    amount: z.number().nullable(),
  }),
  // `interaction` is the declarative UI-hint convention: `label` is the human
  // prompt; `events` refines how each accepted event renders (button label,
  // emphasis). The chat UI derives everything else from the event schemas.
  meta: z.object({
    interaction: z
      .object({
        label: z.string(),
        events: z
          .record(
            z.string(),
            z.object({ label: z.string().optional(), style: z.string().optional() }),
          )
          .optional(),
      })
      .optional(),
  }),
  // The model's legal moves. AUTO_REFUND / REVIEW carry the amount the model
  // extracted from the request text; the machine validates and routes it.
  events: {
    AUTO_REFUND: z.object({ amount: z.number() }),
    REVIEW: z.object({ amount: z.number(), reason: z.string() }),
    NEEDS_DETAILS: z.object({}),
    APPROVE: z.object({}),
    DENY: z.object({}),
  },
  // `awaitingApproval` is an idle human-wait state — declare it as the suspend
  // signal so runAgent settles idle deterministically instead of timing out.
  isIdle: (snapshot) => snapshot.hasTag("awaiting-approval"),
});

export const refundMachine = agentSetup.createMachine({
  id: "refund",
  context: ({ input }) => ({ request: input.request, amount: null }),
  initial: "deciding",
  states: {
    deciding: {
      invoke: {
        src: "agent.decide",
        input: ({ context }) => ({
          model: "fast",
          system:
            "You review refund requests. Choose AUTO_REFUND with the requested " +
            "amount when the customer names a clear dollar amount and the reason " +
            "is a normal refund. Choose REVIEW when the situation needs judgment. " +
            "Choose NEEDS_DETAILS when no amount is stated.",
          prompt: context.request,
          allowedEvents: ["AUTO_REFUND", "REVIEW", "NEEDS_DETAILS"],
        }),
      },
      on: {
        // Static targets — the machine, not the model, owns where each event goes.
        AUTO_REFUND: {
          target: "checkingLimit",
          context: ({ event }) => ({ amount: event.amount }),
        },
        REVIEW: {
          target: "awaitingApproval",
          context: ({ event }) => ({ amount: event.amount }),
        },
        NEEDS_DETAILS: { target: "needsDetails" },
      },
    },
    // The policy gate. A choice state is a pure machine decision: no model runs
    // here. Amounts within the limit auto-refund; anything larger escalates.
    checkingLimit: {
      type: "choice",
      choice: ({ context }) =>
        (context.amount ?? 0) <= 100 ? { target: "refunded" } : { target: "awaitingApproval" },
    },
    // Idle: waits for a human. `meta.interaction` labels the prompt; the legal
    // events (APPROVE / DENY) come from the snapshot via getAcceptedEvents.
    awaitingApproval: {
      tags: ["awaiting-approval"],
      meta: {
        interaction: {
          label: "Amount exceeds the $100 auto-refund limit. Approve or deny.",
          events: {
            APPROVE: { label: "Approve refund", style: "primary" },
            DENY: { label: "Deny", style: "danger" },
          },
        },
      },
      on: {
        APPROVE: { target: "approved" },
        DENY: { target: "denied" },
      },
    },
    refunded: {
      type: "final",
      output: ({ context }) => ({ outcome: "refunded" as const, amount: context.amount }),
    },
    approved: {
      type: "final",
      output: ({ context }) => ({ outcome: "approved" as const, amount: context.amount }),
    },
    denied: {
      type: "final",
      output: ({ context }) => ({ outcome: "denied" as const, amount: context.amount }),
    },
    needsDetails: {
      type: "final",
      output: () => ({ outcome: "needs-details" as const, amount: null }),
    },
  },
});
