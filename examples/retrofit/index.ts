/**
 * AFTER — the `before.ts` support agent as an agent machine.
 *
 * Same observable behavior as the hand-rolled loop, with the tangle unwound:
 *   - the `while` loop → `runAgent`
 *   - phase strings/flags → explicit states
 *   - the tool-choice `if/else` → `agent.decide` + typed events
 *   - the `$100` `if` → a guard on the REFUND transition
 *   - the `{ pending }` sentinel → an idle `awaitingApproval` state you persist
 *   - the retry/backoff wrapper → a custom `generateText` executor (unchanged)
 *
 * `step1/2/3.ts` walk this conversion one shippable step at a time. Dual-mode:
 * tests inject mock executors (keyless); a direct run uses real models.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/retrofit/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAsyncLogic } from "xstate";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";
import {
  createAgentSchemas,
  getAcceptedEvents,
  getStateMeta,
  persistSnapshot,
  runAgent,
  setupAgent,
  type AgentRequestExecutors,
} from "@statelyai/agent";

/** Refunds at or below this settle automatically; above needs a human. */
export const REFUND_LIMIT = 100;

/** A tiny fixed order table (stand-in for your orders DB). */
export const ORDERS: Record<string, { customer: string; total: number; item: string }> = {
  A1001: { customer: "Ada Lovelace", total: 240, item: "Standing desk" },
  B2002: { customer: "Alan Turing", total: 60, item: "Mechanical keyboard" },
};

export const models = defineModels({
  triageModel: openai("gpt-5.4-mini"),
  agent: openai("gpt-5.4-mini"),
});

const triageSchema = z.object({
  category: z.enum(["refund", "question", "complaint"]),
  sentiment: z.enum(["positive", "neutral", "negative"]),
  summary: z.string(),
});

const schemas = createAgentSchemas({
  context: z.object({
    ticket: z.string(),
    triage: triageSchema.nullable(),
    order: z.string().nullable(),
    pendingRefund: z.number().nullable(),
    refunded: z.boolean(),
    escalated: z.boolean(),
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
  meta: z.object({ interaction: z.object({ label: z.string() }).optional() }),
});

const agentSetup = setupAgent({
  schemas,
  models,
  // The machine's own wait signal — `runAgent` settles idle whenever a resting
  // snapshot carries this tag (the `{ pending }` sentinel, now first-class).
  isSuspended: (snapshot) => snapshot.hasTag("awaiting-approval"),
  actorSources: {
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
  requests: {
    triageTicket: {
      schemas: { input: z.object({ ticket: z.string() }), output: triageSchema },
      model: "triageModel",
      system:
        "Triage a support ticket. Return category (refund | question | complaint), " +
        "sentiment, and a one-line summary.",
      prompt: ({ input }) => input.ticket,
    },
  },
  states: {
    // `pendingRefund` is set non-null before the machine reaches these.
    awaitingApproval: { context: { pendingRefund: z.number() } },
  },
});

export const supportMachine = agentSetup.createMachine({
  id: "retrofit-support",
  context: ({ input }) => ({
    ticket: input.ticket,
    triage: null,
    order: null,
    pendingRefund: null,
    refunded: false,
    escalated: false,
    resolution: null,
  }),
  output: ({ context }) => ({
    refunded: context.refunded,
    escalated: context.escalated,
    resolution: context.resolution ?? "",
  }),
  initial: "triaging",
  states: {
    triaging: {
      invoke: {
        src: "triageTicket",
        input: ({ context }) => ({ ticket: context.ticket }),
        onDone: ({ output }) => ({ target: "deciding", context: { triage: output } }),
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
          allowedEvents: ["LOOKUP", "REFUND", "ESCALATE", "RESOLVE"],
          maxRetries: 2,
        }),
        onError: { target: "escalated" },
      },
      on: {
        LOOKUP: { target: "lookingUp" },
        // The `$100` `if`, now a guard: small refunds settle; large refunds route
        // to the human-approval pause. No prompt can talk past it.
        REFUND: ({ event }) =>
          event.amount <= REFUND_LIMIT
            ? {
                target: "refunded",
                context: {
                  refunded: true,
                  resolution: `Refunded $${event.amount}: ${event.reason}`,
                },
              }
            : { target: "awaitingApproval", context: { pendingRefund: event.amount } },
        ESCALATE: ({ event }) => ({
          target: "escalated",
          context: { escalated: true, resolution: `Escalated: ${event.reason}` },
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
        input: ({ event }) => ({ orderId: (event as { orderId: string }).orderId }),
        onDone: ({ output }) => ({ target: "deciding", context: { order: output } }),
      },
    },
    // The `{ pending }` sentinel, now a real idle state: no invoke, so `runAgent`
    // settles `{ status: 'idle', snapshot }` here. Persist it, resume with an
    // event later — no closure, no lost state.
    awaitingApproval: {
      tags: ["awaiting-approval"],
      meta: {
        interaction: {
          label:
            "This refund exceeds the limit and needs approval. APPROVE or DENY (with a reason).",
        },
      },
      on: {
        APPROVE: ({ context }) => ({
          target: "refunded",
          context: {
            refunded: true,
            resolution: `Refunded $${context.pendingRefund} after approval`,
          },
        }),
        DENY: ({ context, event }) => ({
          target: "escalated",
          context: {
            escalated: true,
            resolution: `Refund of $${context.pendingRefund} denied (${event.reason}); escalated`,
          },
        }),
      },
    },
    refunded: { type: "final" },
    escalated: { type: "final" },
    resolved: { type: "final" },
  },
});

/** Host executors: the retry/backoff wrapper from `before.ts`, now wrapping the
 * `generateText` executor unchanged; `decide` comes from the AI SDK adapter. */
function buildExecutors(): Pick<AgentRequestExecutors, "generateText" | "decide"> {
  const ai = createAiSdkExecutors({ models });
  const withRetry =
    (fn: NonNullable<AgentRequestExecutors["generateText"]>): typeof fn =>
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
      throw new Error(`generateText failed after 3 attempts: ${String(lastError)}`);
    };
  return { generateText: withRetry(ai.generateText), decide: ai.decide };
}

export interface RunRetrofitOptions {
  ticket?: string;
  /** For the approval pause: approve (default) or deny the pending refund. */
  approve?: boolean;
  denyReason?: string;
  /** Injected for tests; a direct run builds real executors. */
  executors?: Pick<AgentRequestExecutors, "generateText" | "decide">;
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
    onProgress,
  } = options;

  const progress: string[] = [];
  const track = (snapshot: { value: unknown }) => {
    const state = String(snapshot.value);
    progress.push(state);
    onProgress?.(state);
  };

  const first = await runAgent(supportMachine, {
    input: { ticket },
    executors,
    onTransition: track,
  });

  if (first.status === "done") {
    return { ...first.output, settledIdle: false, progress };
  }
  if (first.status !== "idle") {
    throw new Error(`Expected idle or done, got '${first.status}'.`);
  }

  const { interaction } = getStateMeta(first.snapshot);
  const legalEvents = getAcceptedEvents(first.snapshot).map((event) => event.type);

  const event = approve
    ? ({ type: "APPROVE" } as const)
    : ({ type: "DENY", reason: denyReason } as const);
  const second = await runAgent(supportMachine, {
    snapshot: persistSnapshot(first.snapshot),
    event,
    executors,
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
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
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
