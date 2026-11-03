/**
 * STEP 1 — carve one phase. The classify retry loop becomes states; the rest
 * of the workflow is still `resolveTicket` from before.ts, invoked as one
 * actor.
 *
 * Moved: `for (attempt <= MAX_ATTEMPTS)` + `try/catch` → `classifying`, whose
 * `onError` counts the attempt and either retries or falls back.
 * Stayed: lookups, the refund rules and the reply, inside `resolving`.
 * Gained: `canReach` can now prove the retry is bounded (index.test.ts).
 */
import { createAsyncLogic } from "xstate";
import { z } from "zod";
import { runAgent, setupAgent, type AgentRunOptions } from "@statelyai/agent";
import {
  MAX_ATTEMPTS,
  resolveTicket,
  type Classification,
  type SupportEffects,
  type SupportResult,
  type Ticket,
} from "./before.js";
import { createFakeWorld } from "./effects.js";

const ticketSchema = z.object({ id: z.string(), message: z.string() });
const classificationSchema = z.object({
  intent: z.enum(["refund", "status", "other"]),
  orderId: z.string().nullable(),
  amount: z.number().nullable(),
});

/** The fallback `classifyTicket` returned once the model kept failing. */
const UNCLASSIFIED: Classification = { intent: "other", orderId: null, amount: null };

/** The two actors that touch the world, built over one run's effects. */
export function createActors(effects: SupportEffects) {
  return {
    classify: createAsyncLogic<Classification, Ticket>({
      run: ({ input }) => effects.generate({ task: "classify", ticket: input.message }),
    }),
    // The remainder of before.ts, unchanged: carved in a later step.
    resolve: createAsyncLogic<SupportResult, { ticket: Ticket; classification: Classification }>({
      run: ({ input }) => resolveTicket(input.ticket, input.classification, effects),
    }),
  };
}

const agentSetup = setupAgent({
  actors: createActors(createFakeWorld().effects),
  context: z.object({
    ticket: ticketSchema,
    attempts: z.number(),
    classification: classificationSchema.nullable(),
    result: z.custom<SupportResult>().nullable(),
  }),
  input: ticketSchema,
  output: z.custom<SupportResult>(),
});

export const supportMachine = agentSetup.createMachine({
  id: "support-step1",
  version: "1",
  context: ({ input }) => ({ ticket: input, attempts: 0, classification: null, result: null }),
  initial: "classifying",
  states: {
    classifying: {
      invoke: {
        src: "classify",
        input: ({ context }) => context.ticket,
        onDone: ({ context, output }) => ({
          target: "resolving",
          context: { attempts: context.attempts + 1, classification: output },
        }),
        onError: ({ context }) => ({
          target: "retrying",
          context: { attempts: context.attempts + 1 },
        }),
      },
    },
    retrying: {
      type: "choice",
      choice: ({ context }) =>
        context.attempts < MAX_ATTEMPTS
          ? { target: "classifying" }
          : { target: "resolving", context: { classification: UNCLASSIFIED } },
    },
    resolving: {
      invoke: {
        src: "resolve",
        input: ({ context }) => ({
          ticket: context.ticket,
          classification: context.classification ?? UNCLASSIFIED,
        }),
        onDone: ({ output }) => ({ target: "done", context: { result: output } }),
      },
    },
    done: {
      type: "final",
      output: ({ context }) => context.result!,
    },
  },
});

/**
 * `runTicket`'s signature, on the machine. `options` passes through to
 * `runAgent` (`threadId`, `store`, `metadata`, `onTrace`, `inspect`), so
 * traces and inspection need no copy of this runner.
 */
export async function runTicketStep1(
  ticket: Ticket,
  effects: SupportEffects,
  options: Omit<AgentRunOptions<typeof supportMachine>, "input" | "actors"> = {},
): Promise<SupportResult> {
  const result = await runAgent(supportMachine, {
    ...options,
    input: ticket,
    actors: createActors(effects),
  });
  if (result.status === "done") return result.output;
  throw result.status === "error" ? result.error : new Error(`Run settled ${result.status}`);
}
