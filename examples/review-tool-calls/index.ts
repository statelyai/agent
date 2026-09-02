/**
 * Review tool calls — LangGraph's "review tool calls" human-in-the-loop pattern
 * as explicit, typed machine states.
 *
 * LangGraph shape (how-tos/human_in_the_loop/review-tool-calls): the model emits
 * a tool call, the graph hits an `interrupt()` that surfaces the pending call to
 * a human, and the human resumes with a `Command(resume={...})` carrying one of
 * three decisions:
 *   - "continue"  → run the tool with the args as proposed
 *   - "update"    → run the tool with human-edited args
 *   - "feedback"  → don't run it; feed a message back to the model for a redo
 *
 * Here that interrupt is a first-class idle `reviewing` state (no invoke, tags
 * `['awaiting-review']`, a typed `meta.interaction` label, the pending proposal
 * in `context.proposal`). `runAgent` settles `{ status: 'idle', snapshot }`; the
 * host persists it and resumes with one of three typed events:
 *   - APPROVE {}              → execute the proposal unchanged
 *   - EDIT { override }       → a partial override (any subset of the refund
 *                               fields, validated by the event schema) merged
 *                               over the proposal, then execute — `edited: true`
 *   - REJECT { feedback }     → feedback returns to the model for one revised
 *                               proposal; a second REJECT ends without executing
 *
 * The revision loop is bounded by construction: only the FIRST reject re-proposes
 * (guarded by `revised`); the second lands in a terminal `rejected` state, so at
 * most one model redo happens.
 *
 * Domain: a small ops assistant with one consequential tool, `sendRefund`,
 * executed by a typed plain actor (an in-example fake that records the call to
 * `SENT_REFUNDS`).
 *
 * Dual-mode: `runReviewToolCallsExample(options?)` takes an injectable
 * `generateText` (keyless tests pass a mock) plus a sequence of resume events,
 * each applied across a JSON snapshot round-trip; the direct run uses real models
 * and a readline approve/edit/reject prompt.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/review-tool-calls/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAsyncLogic } from "xstate";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";
import {
  getAcceptedEvents,
  getStateMeta,
  runAgent,
  setupAgent,
  type AgentRequestExecutors,
} from "@statelyai/agent";

export const models = defineModels({
  assistant: openai("gpt-5.4-mini"),
});

// The consequential tool call the model proposes and a human reviews.
const refundCallSchema = z.object({
  orderId: z.string(),
  amountCents: z.number(),
  reason: z.string(),
});
export type RefundCall = z.infer<typeof refundCallSchema>;

/** In-example fake ledger: the typed `sendRefund` actor records every call here. */
export const SENT_REFUNDS: RefundCall[] = [];

const contextSchema = z.object({
  request: z.string(),
  // The pending proposal under review; null before the model proposes / after a
  // reject clears it for a redo.
  proposal: refundCallSchema.nullable(),
  // Last rejection feedback, fed into the next proposal.
  feedback: z.string().nullable(),
  // Bounds the redo loop: true once a reject has triggered one revision.
  revised: z.boolean(),
  // The executed result: whether a human edited the args, and whether it ran.
  edited: z.boolean(),
  executed: z.boolean(),
});

const agentSetup = setupAgent({
  models,
  context: contextSchema,
  input: z.object({ request: z.string() }),
  output: z.object({
    executed: z.boolean(),
    call: refundCallSchema.nullable(),
    edited: z.boolean(),
  }),
  // Typed interaction meta: the pause's `label`, a button `label`/`style` per
  // accepted event, and `textEvent` naming the ONE event free text goes to.
  meta: z.object({
    interaction: z
      .object({
        label: z.string(),
        events: z
          .record(
            z.string(),
            z.object({
              label: z.string().optional(),
              style: z.enum(["primary", "danger", "default"]).optional(),
            }),
          )
          .optional(),
        textEvent: z.string().optional(),
      })
      .optional(),
  }),
  events: {
    APPROVE: z.object({}),
    // Partial override merged over the proposal: `override` carries any subset of
    // the refund fields, validated before it can resume.
    EDIT: z.object({ override: refundCallSchema.partial() }),
    REJECT: z.object({ feedback: z.string() }),
  },
  // The machine's own wait signal: the `awaiting-review` tag. `runAgent` settles
  // idle deterministically whenever a resting snapshot carries it.
  isIdle: (snapshot) => snapshot.hasTag("awaiting-review"),
  actors: {
    // The consequential tool: applies the approved/edited refund. A real host
    // would call a payments API here; this fake records it and returns a receipt.
    sendRefund: createAsyncLogic<RefundCall, RefundCall>({
      run: async ({ input }) => {
        SENT_REFUNDS.push(input);
        return input;
      },
    }),
  },
  requests: {
    // The model proposes a refund tool call as structured output. On a redo the
    // reviewer's feedback is threaded into the prompt.
    proposeRefund: {
      schemas: {
        input: z.object({ request: z.string(), feedback: z.string().nullable() }),
        output: refundCallSchema,
      },
      model: "assistant",
      system:
        "You are an ops assistant that proposes refunds for customer issues. " +
        "Given the request, propose a single refund tool call: the orderId, an " +
        "amountCents (integer cents), and a short reason. Propose only; a human " +
        "reviews before anything runs.",
      prompt: ({ input }) =>
        input.feedback
          ? `${input.request}\n\nA reviewer REJECTED your previous proposal with this feedback: ${input.feedback}\nPropose a revised refund that addresses it.`
          : input.request,
    },
  },
  // `reviewing` and `executing` are reached only after a proposal exists — narrow
  // it non-null in both so the EDIT merge and the invoke input type-check.
  states: {
    reviewing: { context: { proposal: refundCallSchema } },
    executing: { context: { proposal: refundCallSchema } },
  },
});

export const reviewToolCallsMachine = agentSetup.createMachine({
  id: "review-tool-calls",
  context: ({ input }) => ({
    request: input.request,
    proposal: null,
    feedback: null,
    revised: false,
    edited: false,
    executed: false,
  }),
  // Single source of the done result, whichever final state is reached. The call
  // is the proposal that ran (null when rejected without executing).
  output: ({ context }) => ({
    executed: context.executed,
    call: context.executed ? context.proposal : null,
    edited: context.edited,
  }),
  initial: "proposing",
  states: {
    // The model proposes the tool call (fresh, or a redo carrying feedback).
    proposing: {
      invoke: {
        src: "proposeRefund",
        input: ({ context }) => ({ request: context.request, feedback: context.feedback }),
        onDone: ({ output }) => ({ target: "reviewing", context: { proposal: output } }),
      },
    },
    // The interrupt, as an idle state: no invoke → `runAgent` settles idle. The
    // host reads `meta.interaction` + `context.proposal` and legal events from
    // `getAcceptedEvents(snapshot)`, then resumes with APPROVE / EDIT / REJECT.
    reviewing: {
      tags: ["awaiting-review"],
      meta: {
        interaction: {
          label:
            "Review the proposed refund: run it as-is, edit its arguments first, " +
            "or type feedback to get a revised proposal.",
          events: {
            APPROVE: { label: "Run refund as proposed", style: "primary" },
            EDIT: { label: "Edit arguments first" },
            REJECT: { label: "Reject with feedback", style: "danger" },
          },
          // REJECT's `feedback` is the only single-string payload, so free text
          // would land there anyway — say so, and say so in the label too.
          textEvent: "REJECT",
        },
      },
      on: {
        // Execute the proposal unchanged.
        APPROVE: { target: "executing" },
        // Merge the partial override over the proposal (Command(resume={update})).
        EDIT: ({ context, event }) => ({
          target: "executing",
          context: { proposal: { ...context.proposal, ...event.override }, edited: true },
        }),
        // First reject → one revision; second reject → end without executing.
        REJECT: ({ context, event }) =>
          context.revised
            ? { target: "rejected", context: { feedback: event.feedback } }
            : {
                target: "proposing",
                context: { feedback: event.feedback, revised: true, proposal: null },
              },
      },
    },
    // Approved/edited: the tool actually runs (the resumed tool node).
    executing: {
      invoke: {
        src: "sendRefund",
        input: ({ context }) => context.proposal,
        onDone: { target: "executed", context: { executed: true } },
      },
    },
    executed: { type: "final" },
    rejected: { type: "final" },
  },
});

export interface RunReviewToolCallsOptions {
  request?: string;
  /**
   * Resume events applied in order across idle settles (each via a JSON snapshot
   * round-trip). Defaults to a single APPROVE. The last event repeats if the
   * machine settles idle more times than events supplied.
   */
  events?: Array<
    | { type: "APPROVE" }
    | { type: "EDIT"; override: Partial<RefundCall> }
    | { type: "REJECT"; feedback: string }
  >;
  /** Injected for tests; direct run supplies a real model executor. */
  generateText?: AgentRequestExecutors["generateText"];
  /** Observes each machine transition across all runAgent calls. */
  onProgress?: (state: string) => void;
}

export interface ReviewToolCallsResult {
  executed: boolean;
  call: RefundCall | null;
  edited: boolean;
  /** Each proposal shown for review, in order (2 when a reject triggered a redo). */
  proposals: RefundCall[];
  interactionLabel: string | undefined;
  legalEvents: string[];
}

/**
 * Proposes a refund, settles idle for review, then resumes through the supplied
 * events — persisting the snapshot (JSON round-trip) before each resume, exactly
 * like the idle-first human-in-the-loop model.
 */
export async function runReviewToolCallsExample(
  options: RunReviewToolCallsOptions = {},
): Promise<ReviewToolCallsResult> {
  const {
    request = "Customer #A-1000 was double-charged $20 on order ORD-42. Make it right.",
    events = [{ type: "APPROVE" }],
    generateText,
    onProgress,
  } = options;
  const executors = generateText
    ? { executors: { generateText } }
    : { executors: createAiSdkExecutors({ models }) };

  const track = (snapshot: { value: unknown }) => onProgress?.(String(snapshot.value));

  let result = await runAgent(reviewToolCallsMachine, {
    input: { request },
    ...executors,
    onTransition: track,
  });

  const proposals: RefundCall[] = [];
  let interactionLabel: string | undefined;
  let legalEvents: string[] = [];
  let i = 0;

  while (result.status === "idle") {
    if (i === 0) {
      interactionLabel = getStateMeta(result.snapshot).interaction?.label;
      legalEvents = getAcceptedEvents(result.snapshot).map((event) => event.type);
    }
    const proposal = result.snapshot.context.proposal;
    if (proposal) proposals.push(proposal);

    const event = events[i] ?? events[events.length - 1];
    i++;
    result = await runAgent(reviewToolCallsMachine, {
      snapshot: result.persist(),
      event,
      ...executors,
      onTransition: track,
    });
  }

  if (result.status !== "done") {
    throw new Error(`Expected done after review, got '${result.status}'.`);
  }
  return { ...result.output, proposals, interactionLabel, legalEvents };
}

// Direct run: propose a refund, then let the human APPROVE / EDIT / REJECT at the
// idle state. Every resume is fed a persisted snapshot, so the JSON round-trip is
// exercised on each turn.
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
    const request = "Customer #A-1000 was double-charged $20 on order ORD-42. Make it right.";

    let result = await runAgent(reviewToolCallsMachine, {
      input: { request },
      executors,
      onTransition: (snapshot) => console.log(`  → ${String(snapshot.value)}`),
    });

    while (result.status === "idle") {
      const snapshot = result.snapshot;
      const proposal = snapshot.context.proposal;
      const { interaction } = getStateMeta(snapshot);
      const legalEvents = getAcceptedEvents(snapshot).map((event) => event.type);

      console.log("\n--- Proposed tool call: sendRefund ---");
      console.log(JSON.stringify(proposal, null, 2));
      console.log(interaction?.label ?? "");
      console.log("Legal events:", legalEvents.join(", "));

      const persisted = result.persist();
      const answer = (await promptLine("approve / edit / reject? ")).toLowerCase();

      let event:
        | { type: "APPROVE" }
        | { type: "EDIT"; override: Partial<RefundCall> }
        | { type: "REJECT"; feedback: string };
      if (answer.startsWith("e")) {
        const cents = await promptLine("New amountCents (blank = keep): ");
        const reason = await promptLine("New reason (blank = keep): ");
        event = {
          type: "EDIT",
          override: {
            ...(cents ? { amountCents: Number(cents) } : {}),
            ...(reason ? { reason } : {}),
          },
        };
      } else if (answer.startsWith("r")) {
        event = { type: "REJECT", feedback: await promptLine("Feedback for the model: ") };
      } else {
        event = { type: "APPROVE" };
      }

      result = await runAgent(reviewToolCallsMachine, {
        snapshot: persisted,
        event,
        executors,
        onTransition: (snapshot) => console.log(`  → ${String(snapshot.value)}`),
      });
    }

    if (result.status !== "done") {
      throw new Error(`Review did not complete: ${result.status}`);
    }
    console.log("\n--- Result ---");
    console.log(
      result.output.executed
        ? `Executed (${result.output.edited ? "edited" : "as proposed"}): ${JSON.stringify(result.output.call)}`
        : "Not executed (rejected).",
    );
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
