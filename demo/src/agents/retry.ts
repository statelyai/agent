/**
 * Retry & fallback — bounded recovery the machine owns.
 *
 * What the MODEL owns: classifying the ticket (`classify`).
 * What the MACHINE owns: the retry budget. `context.attempts` counts tries; the
 * `retrying` choice state decides whether to try again or give up, and the
 * request picks the fallback model once the primary attempts are spent
 * (`attempt >= 2 → "fallback"`). The loop can never run forever — the bound is
 * a number in context, visible in the chart, not a hidden `while`.
 */
import { z } from "zod";
import { setupAgent } from "@statelyai/agent";

const MAX_ATTEMPTS = 2;

const agentSetup = setupAgent({
  context: z.object({
    ticket: z.string(),
    attempts: z.number(),
    category: z.string().nullable(),
  }),
  input: z.object({ ticket: z.string() }),
  output: z.object({
    category: z.string(),
    attempts: z.number(),
    usedFallback: z.boolean(),
  }),
  requests: {
    classify: {
      schemas: { input: z.object({ ticket: z.string(), attempt: z.number() }), output: z.string() },
      // Primary model for the first attempts; the fallback once they are spent.
      model: ({ input }) => (input.attempt >= MAX_ATTEMPTS ? "fallback" : "primary"),
      system: "Classify the support ticket. Return a concise category, priority, and routing recommendation.",
      prompt: ({ input }) => input.ticket,
    },
  },
});

export const retryMachine = agentSetup.createMachine({
  id: "retry",
  context: ({ input }) => ({ ticket: input.ticket, attempts: 0, category: null }),
  initial: "classifying",
  states: {
    classifying: {
      invoke: {
        src: "classify",
        input: ({ context }) => ({ ticket: context.ticket, attempt: context.attempts }),
        onDone: { target: "complete", context: ({ output }) => ({ category: output }) },
        // A failed model call routes to the bounded retry decision.
        onError: { target: "retrying" },
      },
    },
    // Pure machine decision: another attempt within budget, or give up.
    retrying: {
      type: "choice",
      choice: ({ context }) =>
        context.attempts < MAX_ATTEMPTS
          ? { target: "classifying", context: { attempts: context.attempts + 1 } }
          : { target: "failed" },
    },
    complete: {
      type: "final",
      output: ({ context }) => ({
        category: context.category ?? "",
        attempts: context.attempts,
        usedFallback: context.attempts >= MAX_ATTEMPTS,
      }),
    },
    failed: {
      type: "final",
      output: ({ context }) => ({
        category: "",
        attempts: context.attempts,
        usedFallback: context.attempts >= MAX_ATTEMPTS,
      }),
    },
  },
});
