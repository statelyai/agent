/**
 * Refund guard — the model proposes; policy decides.
 *
 * What the MODEL owns: reading the request and choosing one legal event
 * (`AUTO_REFUND` with an extracted amount, `REVIEW`, or `NEEDS_DETAILS`).
 * What the MACHINE owns: the $100 auto-refund limit. `AUTO_REFUND` never lands
 * on `refunded` directly — it routes through the `checkingLimit` choice state,
 * so the policy, not the model, decides whether an amount can be auto-approved.
 * Over-limit amounts settle idle in `awaitingApproval`, waiting for a human
 * `APPROVE` / `DENY` event. A request with no amount settles idle in
 * `askingAmount` and asks once; the machine, not the model, bounds how many
 * times it asks (`clarifications`).
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
    /** Times the machine has asked for missing details; capped at one. */
    clarifications: z.number(),
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
        textEvent: z.string().optional(),
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
    /** The customer's reply to "how much?" — free text the model re-reads. */
    DETAILS: z.object({ text: z.string() }),
  },
  // Human-wait states carry this tag — declare it as the suspend signal so
  // runAgent settles idle deterministically instead of timing out.
  isIdle: (snapshot) => snapshot.hasTag("awaiting-human"),
});

export const refundMachine = agentSetup.createMachine({
  id: "refund",
  context: ({ input }) => ({ request: input.request, amount: null, clarifications: 0 }),
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
        // Ask once. A second NEEDS_DETAILS ends the run: the bound is the
        // machine's, so the model cannot keep the customer in a loop.
        NEEDS_DETAILS: ({ context }) =>
          context.clarifications < 1
            ? { target: "askingAmount", context: { clarifications: context.clarifications + 1 } }
            : { target: "needsDetails" },
      },
    },
    // Idle: the customer left out the amount. Free text comes back as DETAILS
    // and the model reads the request again with the reply appended.
    askingAmount: {
      tags: ["awaiting-human"],
      meta: {
        interaction: {
          label: "How much was the charge? Reply with the amount.",
          textEvent: "DETAILS",
        },
      },
      on: {
        DETAILS: ({ context, event }) => ({
          target: "deciding",
          context: { request: `${context.request}\nCustomer added: ${event.text}` },
        }),
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
      tags: ["awaiting-human"],
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
