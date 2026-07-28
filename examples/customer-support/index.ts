/**
 * Customer-support bot (airline assistant) — the essence of LangGraph's flagship
 * customer-support tutorial, rebuilt to showcase this library's HITL model.
 *
 * LangGraph splits its tool set into `safe_tools` (read-only: lookup_policy,
 * fetch_user_flight_information) and `sensitive_tools` (mutating:
 * update_ticket_to_new_flight, cancel_ticket). A `route_tools` edge sends the
 * model's tool call to one node or the other, and the graph is compiled with
 * `interrupt_before=["sensitive_tools"]`. When a sensitive tool is about to run
 * the graph pauses; the checkpointer holds the state; a human approves by
 * re-invoking with `None`, or denies by feeding a synthetic `ToolMessage`
 * ("API call denied by user…") back in. The interrupt is a compile-time flag on
 * a node, and "am I paused?" is read off `snapshot.next` outside the graph.
 *
 * Here the same shape is explicit, typed states:
 *   classifying → routing → (answering | confirming → executing/denied)
 *
 *   - Non-sensitive Q&A: ONE `answer` request carries real `tools`
 *     (`lookupBooking`, `searchPolicies` over a small sample table) and the host
 *     runs the tool loop, bounded by `metadata.maxSteps`. The machine never sees
 *     the intermediate tool calls — same as LangGraph's safe-tools path, minus
 *     the extra node. (See examples/tool-calling.)
 *   - Intent routing: a structured-output `classify` request returns a
 *     discriminated union (question | cancel | rebook); a `choice` state routes
 *     on it — the typed analogue of `route_tools`.
 *   - Sensitive action: instead of an `interrupt_before` flag, the machine
 *     *transitions into an idle `confirming` state* — no invoke, tags
 *     `['awaiting-approval']`, a static `meta.interaction` label, and the pending
 *     action in `context.pendingAction`. `runAgent` settles `{ status: 'idle',
 *     snapshot }` deterministically (the machine declares its own wait signal via
 *     `isSuspended`), so pausing is a first-class machine state, not a host-side
 *     `snapshot.next` check. The host persists the snapshot and resumes with an
 *     APPROVE or DENY event in a *second* `runAgent` call. (See
 *     examples/human-in-the-loop.)
 *
 * Dual-mode: `runCustomerSupportExample(options?)` takes an injectable
 * `generateText` (keyless tests pass a mock); the direct run uses real models
 * and a readline approve/deny prompt.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/customer-support/index.ts
 */
import { z } from "zod";
import { tool } from "ai";
import { openai } from "@ai-sdk/openai";
import { createAsyncLogic } from "xstate";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";
import {
  getAcceptedEvents,
  getStateMeta,
  persistSnapshot,
  runAgent,
  setupAgent,
  type AgentRequestExecutors,
} from "@statelyai/agent";

export const models = defineModels({
  router: openai("gpt-5.4-mini"),
  assistant: openai("gpt-5.4-mini"),
});

// ─── sample data (stand-ins for the tutorial's SQLite airline DB) ───

export interface Booking {
  passenger: string;
  flight: string;
  status: "confirmed" | "cancelled";
}

/** A tiny fixed booking table, keyed by confirmation code. */
export const BOOKINGS: Record<string, Booking> = {
  AB1234: {
    passenger: "Ada Lovelace",
    flight: "BA249 LHR→GRU, 2026-08-02 21:30",
    status: "confirmed",
  },
  CD5678: {
    passenger: "Alan Turing",
    flight: "AA100 JFK→LHR, 2026-09-14 18:15",
    status: "confirmed",
  },
};

/** A tiny policy table (stand-in for LangGraph's `lookup_policy` retriever). */
export const POLICIES: Record<string, string> = {
  cancellation:
    "Economy tickets are refundable up to 24 hours before departure; after that a $150 fee applies.",
  baggage:
    "One carry-on and one personal item are included. Checked bags are $40 each, up to three.",
  changes: "Flight changes incur a $75 fee plus any fare difference, subject to seat availability.",
};

// ─── schemas ───

// The classifier's typed decision — the analogue of LangGraph's `route_tools`.
// `cancel`/`rebook` are the sensitive branches; `question` is the safe branch.
// A tool/intent the union can't validate never reaches a sensitive path.
const intentSchema = z.union([
  z.object({ intent: z.literal("question") }),
  z.object({ intent: z.literal("cancel"), confirmationCode: z.string() }),
  z.object({ intent: z.literal("rebook"), confirmationCode: z.string(), newFlight: z.string() }),
]);

// The pending sensitive action, held in context while the machine waits idle for
// approval (the dynamic detail behind the static `meta.interaction` label).
const pendingActionSchema = z.object({
  type: z.enum(["cancel", "rebook"]),
  confirmationCode: z.string(),
  newFlight: z.string().nullable(),
  summary: z.string(),
});
export type PendingAction = z.infer<typeof pendingActionSchema>;

const resolutionSchema = z.enum(["answered", "executed", "denied"]);

const contextSchema = z.object({
  query: z.string(),
  pendingAction: pendingActionSchema.nullable(),
  answer: z.string().nullable(),
  result: z.string().nullable(),
  resolution: resolutionSchema.nullable(),
});

const agentSetup = setupAgent({
  models,
  context: contextSchema,
  input: z.object({ query: z.string() }),
  output: z.object({ resolution: resolutionSchema, message: z.string() }),
  meta: z.object({ interaction: z.object({ label: z.string() }).optional() }),
  events: {
    APPROVE: z.object({}),
    DENY: z.object({ reason: z.string() }),
  },
  // The machine's own wait signal: the `confirming` tag. `runAgent` settles idle
  // deterministically whenever a resting snapshot carries it — no timing
  // heuristic, no host-side `snapshot.next` check.
  isSuspended: (snapshot) => snapshot.hasTag("awaiting-approval"),
  actors: {
    // Applies the approved sensitive action. Reads the real booking table and
    // returns a confirmation message. (A production host would persist the
    // change and enforce policy here — see the tutorial's cancel_ticket.)
    executeAction: createAsyncLogic<string, PendingAction>({
      run: async ({ input }) => {
        const booking = BOOKINGS[input.confirmationCode];
        if (!booking) {
          return `No booking found for ${input.confirmationCode}; nothing changed.`;
        }
        if (input.type === "cancel") {
          return `Booking ${input.confirmationCode} (${booking.flight}) is now cancelled. A refund will follow per policy.`;
        }
        return `Booking ${input.confirmationCode} moved from ${booking.flight} to ${input.newFlight}. A $75 change fee applies.`;
      },
    }),
  },
  requests: {
    // Intent router: structured output only, no tools. The typed union is the
    // guard — a hallucinated intent can't validate, so it never routes to a
    // sensitive path.
    classify: {
      schemas: {
        input: z.object({ query: z.string() }),
        output: intentSchema,
      },
      model: "router",
      system:
        "You route airline customer-support messages. Return `question` for " +
        "anything answerable from bookings or policies (fees, baggage, 'what's " +
        "my flight'). Return `cancel` (with the confirmationCode) to cancel a " +
        "booking, or `rebook` (with confirmationCode and newFlight) to change " +
        "one. Only choose cancel/rebook when the user explicitly asks to modify " +
        "a booking.",
      prompt: ({ input }) => input.query,
    },
    // Safe Q&A: one request, real read-only tools, host-run tool loop.
    answer: {
      schemas: {
        input: z.object({ query: z.string() }),
        output: z.string(),
      },
      model: "assistant",
      system:
        "You are an airline support agent. Answer in one or two friendly " +
        "sentences. Use lookupBooking to read a booking by confirmation code, " +
        "and searchPolicies for fees, baggage, cancellation, or change rules.",
      prompt: ({ input }) => input.query,
      tools: {
        lookupBooking: tool({
          description: "Look up a booking by its confirmation code.",
          inputSchema: z.object({ confirmationCode: z.string() }),
          execute: async ({ confirmationCode }) => {
            const booking = BOOKINGS[confirmationCode.toUpperCase()];
            return booking ?? { error: `no booking for ${confirmationCode}` };
          },
        }),
        searchPolicies: tool({
          description: "Look up an airline policy by topic (cancellation, baggage, changes).",
          inputSchema: z.object({ topic: z.enum(["cancellation", "baggage", "changes"]) }),
          execute: async ({ topic }) => ({ topic, text: POLICIES[topic] }),
        }),
      },
      // Bound the host-side tool loop (the AI SDK adapter reads this).
      metadata: { maxSteps: 5 },
    },
  },
  // `confirming` and `executing` are reached only after classify set a sensitive
  // `pendingAction` — narrow it non-null there so the invoke input type-checks.
  states: {
    confirming: { context: { pendingAction: pendingActionSchema } },
    executing: { context: { pendingAction: pendingActionSchema } },
  },
});

export const customerSupportMachine = agentSetup.createMachine({
  id: "customer-support",
  context: ({ input }) => ({
    query: input.query,
    pendingAction: null,
    answer: null,
    result: null,
    resolution: null,
  }),
  // Single source of the done result, whichever final state is reached.
  output: ({ context }) => ({
    resolution: context.resolution ?? "answered",
    message: context.answer ?? context.result ?? "",
  }),
  initial: "classifying",
  states: {
    // Classify intent, and (for sensitive intents) stage the pending action.
    classifying: {
      invoke: {
        src: "classify",
        input: ({ context }) => ({ query: context.query }),
        onDone: ({ output }) => ({
          target: "routing",
          context: {
            pendingAction:
              output.intent === "question"
                ? null
                : {
                    type: output.intent,
                    confirmationCode: output.confirmationCode,
                    newFlight: output.intent === "rebook" ? output.newFlight : null,
                    summary:
                      output.intent === "cancel"
                        ? `Cancel booking ${output.confirmationCode}`
                        : `Rebook ${output.confirmationCode} onto ${output.newFlight}`,
                  },
          },
        }),
      },
    },
    // The typed analogue of LangGraph's `route_tools`: safe → answer, sensitive
    // → confirm with a human first.
    routing: {
      type: "choice",
      choice: ({ context }) =>
        context.pendingAction === null ? { target: "answering" } : { target: "confirming" },
    },
    // Safe path: one request runs its own tool loop; the machine never sees the
    // intermediate calls.
    answering: {
      invoke: {
        src: "answer",
        input: ({ context }) => ({ query: context.query }),
        onDone: ({ output }) => ({
          target: "answered",
          context: { answer: output, resolution: "answered" },
        }),
      },
    },
    answered: { type: "final" },
    // Sensitive path, gate: no invoke → `runAgent` settles idle here. The host
    // reads `meta.interaction` (static label) + `context.pendingAction` (the
    // specifics) and legal events from `getAcceptedEvents(snapshot)`. This is
    // the `interrupt_before=["sensitive_tools"]` pause, as an explicit state.
    confirming: {
      tags: ["awaiting-approval"],
      meta: {
        interaction: {
          label:
            "This action modifies a booking and needs your approval. Reply APPROVE to proceed or DENY (with a reason) to skip it.",
        },
      },
      on: {
        APPROVE: { target: "executing" },
        // LangGraph's denial feeds a `ToolMessage` reason back to the model;
        // here the reason is captured on the DENY event and the machine finishes
        // without touching the booking.
        DENY: ({ event }) => ({
          target: "denied",
          context: {
            resolution: "denied",
            result: `Action skipped at your request. Reason: ${event.reason}`,
          },
        }),
      },
    },
    // Approved: now the sensitive action actually runs (the resumed
    // `sensitive_tools` node).
    executing: {
      invoke: {
        src: "executeAction",
        input: ({ context }) => context.pendingAction,
        onDone: ({ output }) => ({
          target: "executed",
          context: { result: output, resolution: "executed" },
        }),
      },
    },
    executed: { type: "final" },
    denied: { type: "final" },
  },
});

export interface RunCustomerSupportOptions {
  query?: string;
  /** For the sensitive path: approve (default) or deny the pending action. */
  approve?: boolean;
  /** Reason attached to a DENY (the tutorial's denial explanation). */
  denyReason?: string;
  /** Injected for tests; direct run supplies a real model executor. */
  generateText?: AgentRequestExecutors["generateText"];
  /** Observes each machine transition across both runAgent calls. */
  onProgress?: (state: string) => void;
}

export interface CustomerSupportResult {
  resolution: z.infer<typeof resolutionSchema>;
  message: string;
  /** True when the query hit the sensitive path and settled idle for approval. */
  settledIdle: boolean;
  progress: string[];
  /** Sensitive-path only (undefined for a direct answer): the idle-state label. */
  interactionLabel?: string;
  /** Sensitive-path only: legal events read from the idle snapshot. */
  legalEvents?: string[];
  /** Sensitive-path only: the staged action the human is approving. */
  pendingAction?: PendingAction;
}

/**
 * Runs one support turn. Direct-answer queries finish in a single `runAgent`
 * call. Sensitive queries settle idle at `confirming`; this then persists the
 * snapshot (JSON round-trip) and resumes with APPROVE or DENY in a second call.
 */
export async function runCustomerSupportExample(
  options: RunCustomerSupportOptions = {},
): Promise<CustomerSupportResult> {
  const {
    query = "What's the baggage policy?",
    approve = true,
    denyReason = "Changed my mind.",
    generateText,
    onProgress,
  } = options;
  const executors = generateText
    ? { executors: { generateText } }
    : { executors: createAiSdkExecutors({ models }) };

  const progress: string[] = [];
  const track = (snapshot: { value: unknown }) => {
    const state = String(snapshot.value);
    progress.push(state);
    onProgress?.(state);
  };

  // Phase 1: classify, then either answer (done) or settle idle for approval.
  const first = await runAgent(customerSupportMachine, {
    input: { query },
    ...executors,
    onTransition: track,
  });

  if (first.status === "done") {
    return {
      resolution: first.output.resolution,
      message: first.output.message,
      settledIdle: false,
      progress,
    };
  }
  if (first.status !== "idle") {
    throw new Error(`Expected idle or done, got '${first.status}'.`);
  }

  // Idle at `confirming`: read what the host needs to show the human.
  const { interaction } = getStateMeta(first.snapshot);
  const legalEvents = getAcceptedEvents(first.snapshot).map((event) => event.type);
  const pendingAction = first.snapshot.context.pendingAction ?? undefined;

  // Phase 2: ...later, new process, human decided. Same machine, one event,
  // resumed from the persisted (JSON-round-tripped) snapshot.
  const event = approve
    ? ({ type: "APPROVE" } as const)
    : ({ type: "DENY", reason: denyReason } as const);
  const second = await runAgent(customerSupportMachine, {
    snapshot: persistSnapshot(first.snapshot),
    event,
    ...executors,
    onTransition: track,
  });
  if (second.status !== "done") {
    throw new Error(`Expected done after ${event.type}, got '${second.status}'.`);
  }

  return {
    resolution: second.output.resolution,
    message: second.output.message,
    settledIdle: true,
    progress,
    interactionLabel: interaction?.label,
    legalEvents,
    pendingAction,
  };
}

// Direct run: classify a query; if it settles idle for a sensitive action, print
// the pending action and ask the human to approve or deny (with a reason). Every
// resume is fed a persisted snapshot, so the JSON round-trip is exercised.
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
    const executors = createAiSdkExecutors({ models });

    const query =
      (await promptLine("Ask the airline bot (blank = cancel AB1234) > ")) ||
      "Please cancel my booking AB1234.";

    let result = await runAgent(customerSupportMachine, {
      input: { query },
      executors,
      onTransition: (snapshot) => console.log(`  → ${String(snapshot.value)}`),
    });

    if (result.status === "idle") {
      const snapshot = result.snapshot;
      const { interaction } = getStateMeta(snapshot);
      const legalEvents = getAcceptedEvents(snapshot).map((event) => event.type);

      console.log("\n--- Approval required ---");
      console.log("Pending action:", snapshot.context.pendingAction?.summary);
      console.log(interaction?.label ?? "");
      console.log("Legal events:", legalEvents.join(", "));

      const persisted = persistSnapshot(snapshot);
      const answer = (await promptLine("approve / deny? ")).toLowerCase();
      const event = answer.startsWith("a")
        ? ({ type: "APPROVE" } as const)
        : ({ type: "DENY", reason: await promptLine("Reason: ") } as const);

      result = await runAgent(customerSupportMachine, {
        snapshot: persisted,
        event,
        executors,
        onTransition: (snapshot) => console.log(`  → ${String(snapshot.value)}`),
      });
    }

    if (result.status !== "done") {
      throw new Error(`Support turn did not complete: ${result.status}`);
    }
    console.log("\n--- Result ---");
    console.log(`[${result.output.resolution}] ${result.output.message}`);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
