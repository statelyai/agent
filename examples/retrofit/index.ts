/**
 * AFTER — the `before.ts` support agent as an agent machine.
 *
 * Same observable behavior as the hand-rolled loop, with the tangle unwound:
 *   - the `while` loop → `runAgent`
 *   - phase strings/flags → explicit states
 *   - the tool-choice `if/else` → `agent.decide` + typed events
 *   - the `$100` `if` → a guard on the REFUND transition
 *   - the `{ pending }` sentinel → an idle `awaitingApproval` state you persist
 *   - the retry/backoff wrapper → a wrapper around the host's executors (unchanged)
 *   - the `refunded` / `escalated` booleans → gone: each final state declares
 *     its own `output`, so the outcome is the state, not a flag beside it
 *   - the unbounded tool loop → a `lookups` counter checked against MAX_LOOKUPS
 *
 * `step1/2/3.ts` walk this conversion one shippable step at a time. Dual-mode:
 * tests inject mock executors (no API key); a direct run uses real models.
 *
 * The final form adds triage, and triage is a JUDGMENT, not a generation:
 * `triageTicket` calls the AI SDK's `experimental_evaluate` with Jev
 * (`@ai-sdk/typesafe-ai`) as the evaluation model: two `choice` questions over
 * `{ ticket }` in one call, `category` (refund | question | complaint) and
 * `sentiment` (positive | neutral | negative). The labels land in context and
 * the decision reads them. The text model is left with the one open-ended
 * call, `agent.decide`.
 *
 * Run: OPENAI_API_KEY=... TYPESAFE_AI_API_KEY=... npx tsx examples/retrofit/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAsyncLogic } from "xstate";
import { experimental_evaluate as evaluate, type Experimental_EvaluationModel } from "ai";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import {
  createAgentSchemas,
  getInteraction,
  getStatePath,
  interactionMetaSchema,
  runAgent,
  setupAgent,
  type AgentRequestExecutors,
} from "@statelyai/agent";

/** Refunds at or below this settle automatically; above needs a human. */
export const REFUND_LIMIT = 100;

/** Order lookups one ticket may make before the model must commit to an action. */
export const MAX_LOOKUPS = 2;

/** A tiny fixed order table (stand-in for your orders DB). */
export const ORDERS: Record<string, { customer: string; total: number; item: string }> = {
  A1001: { customer: "Ada Lovelace", total: 240, item: "Standing desk" },
  B2002: { customer: "Alan Turing", total: 60, item: "Mechanical keyboard" },
};

const models = {
  agent: openai("gpt-6-luna"),
};

/**
 * The judge: TypeSafe's Jev through the AI SDK's evaluation-model provider.
 * Reads `TYPESAFE_AI_API_KEY`. Tests pass a mock evaluation model instead.
 */
const judgeModel: Experimental_EvaluationModel = typeSafeAi.evaluationModel("jev-latest");

const triageSchema = z.object({
  category: z.enum(["refund", "question", "complaint"]),
  sentiment: z.enum(["positive", "neutral", "negative"]),
});

/**
 * Triage as a judgment: the ticket is the state, and `category` and
 * `sentiment` are two independent `choice` questions asked in one call. The
 * judge model is injected by tests and hosts; the default is Jev, which reads
 * `TYPESAFE_AI_API_KEY` from the environment.
 */
export function createTriageTicket(model: Experimental_EvaluationModel = judgeModel) {
  return createAsyncLogic<
    {
      answers: {
        category: { choice: z.infer<typeof triageSchema>["category"] };
        sentiment: { choice: z.infer<typeof triageSchema>["sentiment"] };
      };
    },
    { ticket: string }
  >({
    run: async ({ input, signal }) => {
      const { answers } = await evaluate({
        model,
        state: { ticket: input.ticket },
        questions: {
          category: {
            type: "choice" as const,
            instructions: "What is the customer asking for in `ticket`?",
            criteria: {
              refund: "Money back for an order, in full or in part.",
              question: "Information: order status, shipping, how something works.",
              complaint: "A problem reported without asking for money back.",
            },
          },
          sentiment: {
            type: "choice" as const,
            instructions: "What is the customer's tone in `ticket`?",
            criteria: {
              positive: "Pleased or appreciative.",
              neutral: "Matter-of-fact.",
              negative: "Frustrated, upset, or angry.",
            },
          },
        },
        abortSignal: signal,
      });
      return { answers };
    },
  });
}

const schemas = createAgentSchemas({
  context: z.object({
    ticket: z.string(),
    triage: triageSchema.nullable(),
    order: z.string().nullable(),
    /** The order id the last LOOKUP asked for; the invoke reads it from here
     * rather than reaching back into the triggering event. */
    lookupOrderId: z.string().nullable(),
    /** Lookups made so far; bounds the deciding → lookingUp loop. */
    lookups: z.number(),
    pendingRefund: z.number().nullable(),
    resolution: z.string().nullable(),
  }),
  input: z.object({ ticket: z.string() }),
  output: z.object({
    refunded: z.boolean(),
    escalated: z.boolean(),
    resolution: z.string(),
  }),
  events: {
    LOOKUP: z.object({ orderId: z.string() }),
    REFUND: z.object({ amount: z.number(), reason: z.string() }),
    ESCALATE: z.object({ reason: z.string() }),
    RESOLVE: z.object({ message: z.string() }),
    APPROVE: z.object({}),
    DENY: z.object({ reason: z.string() }),
  },
  // The shipped interaction protocol, not a per-machine restatement of it: the
  // pause's `label`, a button `label`/`style` per accepted event, and
  // `textEvent` naming the ONE event free text goes to.
  meta: interactionMetaSchema,
});

const agentSetup = setupAgent({
  schemas,
  models,
  actors: {
    // Triage: a Jev judgment (see createTriageTicket).
    triageTicket: createTriageTicket(),
    // The `lookupOrder` tool, now a typed actor. Reads the sample table.
    lookupOrder: createAsyncLogic<string, { orderId: string }>({
      run: async ({ input }) => {
        const order = ORDERS[input.orderId];
        return order
          ? `Order ${input.orderId}: ${order.item}, $${order.total}, ${order.customer}`
          : `Order ${input.orderId} not found`;
      },
    }),
  },
  states: {
    // Each of these is only reachable once the field it needs is set.
    awaitingApproval: {
      schemas: { context: schemas.context.extend({ pendingRefund: z.number() }) },
    },
    lookingUp: {
      schemas: { context: schemas.context.extend({ lookupOrderId: z.string() }) },
    },
  },
});

export const supportMachine = agentSetup.createMachine({
  id: "retrofit-support",
  context: ({ input }) => ({
    ticket: input.ticket,
    triage: null,
    order: null,
    lookupOrderId: null,
    lookups: 0,
    pendingRefund: null,
    resolution: null,
  }),
  initial: "triaging",
  states: {
    triaging: {
      invoke: {
        src: "triageTicket",
        input: ({ context }) => ({ ticket: context.ticket }),
        onDone: ({ output: { answers } }) => ({
          target: "deciding",
          context: {
            triage: { category: answers.category.choice, sentiment: answers.sentiment.choice },
          },
        }),
        onError: ({ event }) => ({
          target: "escalated",
          context: { resolution: `Triage failed, escalated: ${String(event.error)}` },
        }),
      },
    },
    // The tool-choice `if/else`, now a decision over typed events.
    deciding: {
      invoke: {
        src: "agent.decide",
        input: ({ context }) => ({
          model: "agent",
          system:
            "You are a support agent. Look up an order when useful, issue small " +
            "refunds directly, escalate what you cannot resolve, or close with a reply.",
          prompt: [
            `Ticket: ${context.ticket}`,
            context.triage ? `Triage: ${JSON.stringify(context.triage)}` : "",
            context.order ? `Order: ${context.order}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
          // Once the lookup budget is spent, LOOKUP is not even offered — the
          // guard below is still the truth, this just saves a wasted retry.
          allowedEvents:
            context.lookups >= MAX_LOOKUPS
              ? ["REFUND", "ESCALATE", "RESOLVE"]
              : ["LOOKUP", "REFUND", "ESCALATE", "RESOLVE"],
          maxRetries: 2,
        }),
        onError: ({ event }) => ({
          target: "escalated",
          context: { resolution: `Decision failed, escalated: ${String(event.error)}` },
        }),
      },
      on: {
        // Bounded: over the lookup budget the transition returns nothing, so
        // LOOKUP is not an accepted event and the decision must commit.
        LOOKUP: ({ context, event }) =>
          context.lookups >= MAX_LOOKUPS
            ? undefined
            : {
                target: "lookingUp",
                // Carry the id in context: the invoke below then reads its own
                // input from context instead of casting the triggering event.
                context: { lookupOrderId: event.orderId, lookups: context.lookups + 1 },
              },
        // The `$100` `if`, now a guard: small refunds settle; large refunds route
        // to the human-approval pause. No prompt can talk past it.
        REFUND: ({ event }) =>
          event.amount <= REFUND_LIMIT
            ? {
                target: "refunded",
                context: { resolution: `Refunded $${event.amount}: ${event.reason}` },
              }
            : { target: "awaitingApproval", context: { pendingRefund: event.amount } },
        ESCALATE: ({ event }) => ({
          target: "escalated",
          context: { resolution: `Escalated: ${event.reason}` },
        }),
        RESOLVE: ({ event }) => ({
          target: "resolved",
          context: { resolution: event.message },
        }),
      },
    },
    lookingUp: {
      invoke: {
        src: "lookupOrder",
        // No cast: the id was written to context by the LOOKUP transition, and
        // `states.lookingUp` narrows it to a non-null string.
        input: ({ context }) => ({ orderId: context.lookupOrderId }),
        onDone: ({ output }) => ({ target: "deciding", context: { order: output } }),
        onError: ({ event }) => ({
          target: "escalated",
          context: { resolution: `Order lookup failed, escalated: ${String(event.error)}` },
        }),
      },
    },
    // The `{ pending }` sentinel, now a real idle state: no invoke, so `runAgent`
    // settles `{ status: 'idle', snapshot }` here. Persist it, resume with an
    // event later — no closure, no lost state.
    awaitingApproval: {
      tags: ["awaiting-approval"],
      meta: {
        interaction: {
          // `{pendingRefund}` resolves against the snapshot's context when
          // `getInteraction` renders the label.
          label:
            "The ${pendingRefund} refund exceeds the limit and needs approval. " +
            "Approve it, or type a reason to deny it.",
          events: {
            APPROVE: { label: "Approve refund of ${pendingRefund}", style: "primary" },
            DENY: { label: "Deny and escalate", style: "danger" },
          },
          // Without this, free text would silently DENY (its `reason` is the
          // only single-string payload here).
          textEvent: "DENY",
        },
      },
      on: {
        APPROVE: ({ context }) => ({
          target: "refunded",
          context: { resolution: `Refunded $${context.pendingRefund} after approval` },
        }),
        DENY: ({ context, event }) => ({
          target: "escalated",
          context: {
            resolution: `Refund of $${context.pendingRefund} denied (${event.reason}); escalated`,
          },
        }),
      },
    },
    // Three outcomes, three final states, each declaring its own output. The
    // `refunded` / `escalated` booleans the loop kept in a mutable object are
    // now the identity of the state the machine ends in.
    refunded: {
      type: "final",
      output: ({ context }) => ({
        refunded: true,
        escalated: false,
        resolution: context.resolution ?? "",
      }),
    },
    escalated: {
      type: "final",
      output: ({ context }) => ({
        refunded: false,
        escalated: true,
        resolution: context.resolution ?? "",
      }),
    },
    resolved: {
      type: "final",
      output: ({ context }) => ({
        refunded: false,
        escalated: false,
        resolution: context.resolution ?? "",
      }),
    },
  },
});

/** Host executors: the retry/backoff wrapper from `before.ts`, unchanged,
 * now wrapping the AI SDK adapter's `decide` (the machine's one text-model
 * call; triage is a Jev judgment). */
function buildExecutors(): Pick<AgentRequestExecutors, "decide"> {
  const ai = createAiSdkExecutors({ models });
  const withRetry =
    (fn: NonNullable<AgentRequestExecutors["decide"]>): typeof fn =>
    async (request, info) => {
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await fn(request, info);
        } catch (error) {
          lastError = error;
          await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 50));
        }
      }
      throw new Error(`decide failed after 3 attempts: ${String(lastError)}`);
    };
  return { decide: withRetry(ai.decide) };
}

export interface RunRetrofitOptions {
  ticket?: string;
  /** For the approval pause: approve (default) or deny the pending refund. */
  approve?: boolean;
  denyReason?: string;
  /** Injected for tests; a direct run builds real executors. */
  executors?: Pick<AgentRequestExecutors, "decide">;
  /** The judge model; tests pass a mock, a direct run uses Jev. */
  judge?: Experimental_EvaluationModel;
  onProgress?: (state: string) => void;
}

export interface RetrofitResult {
  refunded: boolean;
  escalated: boolean;
  resolution: string;
  /** True when the ticket hit the refund-approval pause and settled idle. */
  settledIdle: boolean;
  progress: string[];
  interactionLabel?: string;
  legalEvents?: string[];
}

/**
 * Runs one ticket. Small refunds / replies / escalations finish in a single
 * `runAgent` call. A large refund settles idle at `awaitingApproval`; this
 * persists the snapshot (JSON round-trip) and resumes with APPROVE or DENY.
 */
export async function runRetrofitExample(
  options: RunRetrofitOptions = {},
): Promise<RetrofitResult> {
  const {
    ticket = "Please refund order A1001, it arrived damaged.",
    approve = true,
    denyReason = "Outside refund policy.",
    executors = buildExecutors(),
    judge,
    onProgress,
  } = options;
  const actors = judge ? { triageTicket: createTriageTicket(judge) } : undefined;

  const progress: string[] = [];
  const track = (snapshot: { value: Parameters<typeof getStatePath>[0] }) => {
    const state = getStatePath(snapshot.value);
    progress.push(state);
    onProgress?.(state);
  };

  const first = await runAgent(supportMachine, {
    input: { ticket },
    executors,
    ...(actors ? { actors } : {}),
    onTransition: track,
  });

  if (first.status === "done") {
    return { ...first.output, settledIdle: false, progress };
  }
  if (first.status !== "idle") {
    throw new Error(`Expected idle or done, got '${first.status}'.`);
  }

  // One call: the resolved label, and the choices XState will currently accept.
  const interaction = getInteraction(first.snapshot);
  const legalEvents = interaction?.events.map((choice) => choice.type) ?? [];

  const event = approve
    ? ({ type: "APPROVE" } as const)
    : ({ type: "DENY", reason: denyReason } as const);
  const second = await runAgent(supportMachine, {
    snapshot: first.persist(),
    event,
    executors,
    ...(actors ? { actors } : {}),
    onTransition: track,
  });
  if (second.status !== "done") {
    throw new Error(`Expected done after ${event.type}, got '${second.status}'.`);
  }

  return {
    ...second.output,
    settledIdle: true,
    progress,
    interactionLabel: interaction?.label,
    legalEvents,
  };
}

/** Prompt once on stdin and resolve the trimmed reply. */
async function promptLine(query: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(query)).trim();
  } finally {
    rl.close();
  }
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY || !process.env.TYPESAFE_AI_API_KEY) {
    console.error("Set OPENAI_API_KEY and TYPESAFE_AI_API_KEY to run this example.");
    process.exit(1);
  }
  void (async () => {
    const ticket =
      (await promptLine("Support ticket (blank = refund A1001) > ")) ||
      "Please refund order A1001, it arrived damaged.";

    const result = await runRetrofitExample({
      ticket,
      onProgress: (state) => console.log(`  → ${state}`),
      // Interactive approve/deny at the pause.
      approve: true,
    });

    console.log("\n--- Result ---");
    console.log(JSON.stringify(result, null, 2));
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
