/**
 * Intent routing — Jev classifies the request; the machine owns every
 * destination.
 *
 * What JEV owns: one `choice` over the request (`billing` / `technical` /
 * `account` / `unclear`). Routing is a typed judgment over text the machine
 * already holds, not a generation, so it goes to TypeSafe's System One model
 * rather than a text model: the answer is a label with a confidence, no prose.
 * What the MACHINE owns: where each label goes, and how sure is sure enough.
 * The routing table is the invoke's `onDone`, and a pick below
 * `ROUTING_CONFIDENCE` goes to clarification like `unclear` does. The reason
 * shown in the chat is rendered from the chosen label's criterion, so it is
 * the same text Jev was asked to judge against.
 */
import { z } from "zod";
import { choice, type TypeSafeClient } from "@typesafe-ai/sdk";
import { setupAgent } from "@statelyai/agent";
import { createSystemOneLogic } from "@statelyai/agent/typesafe";

/** Route only when Jev's confidence in its pick clears this; otherwise ask. */
export const ROUTING_CONFIDENCE = 0.5;

const INTENTS = {
  billing: "Charges, payments, refunds, or invoices.",
  technical: "Product failures, crashes, or errors.",
  account: "Login, password, or profile access.",
  unclear: "The request does not say enough to pick a queue.",
} as const;

/** The routing judgment: one `choice` over the request. `client` is injected by tests. */
export function createClassifyIntent(client?: TypeSafeClient) {
  return createSystemOneLogic({
    client,
    state: (input: { query: string }) => ({ query: input.query }),
    questions: () => ({
      intent: choice("Which support queue should handle `query`?", INTENTS),
    }),
  });
}

const agentSetup = setupAgent({
  context: z.object({
    query: z.string(),
    queue: z.string().nullable(),
    reason: z.string().nullable(),
  }),
  input: z.object({ query: z.string() }),
  output: z.object({ queue: z.string(), reason: z.string() }),
  actors: { classifyIntent: createClassifyIntent() },
});

function routed(
  context: { queue: string | null; reason: string | null },
  fallback: string,
): { queue: string; reason: string } {
  return { queue: context.queue ?? fallback, reason: context.reason ?? "No reason given." };
}

/** Every route carries the WHY: the matched criterion and Jev's confidence in it. */
function reasonFor(intent: keyof typeof INTENTS, confidence: number): string {
  return `${INTENTS[intent]} (Jev confidence ${Math.round(confidence * 100)}%)`;
}

export const routingMachine = agentSetup.createMachine({
  id: "routing",
  context: ({ input }) => ({ query: input.query, queue: null, reason: null }),
  initial: "classifying",
  states: {
    classifying: {
      invoke: {
        src: "classifyIntent",
        input: ({ context }) => ({ query: context.query }),
        // Static targets: the machine, not the model, owns each queue, and
        // every target stays visible in this expression. A pick Jev is unsure
        // of goes to clarification like `unclear` does.
        onDone: ({ output }) => {
          const { choice: intent, confidence } = output.answers.intent;
          const reason = reasonFor(intent, confidence);
          return intent === "unclear" || confidence < ROUTING_CONFIDENCE
            ? { target: "needsClarification", context: { queue: "unclear", reason } }
            : intent === "billing"
              ? { target: "billingQueue", context: { queue: "billing", reason } }
              : intent === "technical"
                ? { target: "technicalQueue", context: { queue: "technical", reason } }
                : { target: "accountQueue", context: { queue: "account", reason } };
        },
        onError: {
          target: "needsClarification",
          context: { queue: "unclear", reason: "The classifier was unavailable." },
        },
      },
    },
    billingQueue: { type: "final", output: ({ context }) => routed(context, "billing") },
    technicalQueue: { type: "final", output: ({ context }) => routed(context, "technical") },
    accountQueue: { type: "final", output: ({ context }) => routed(context, "account") },
    needsClarification: { type: "final", output: ({ context }) => routed(context, "unclear") },
  },
});
