/**
 * Who owns the tool loop? Two variants on one axis.
 *
 *   1. Machine-owned (`reviewToolCallsMachine`, below): the model only PROPOSES
 *      a call, the machine pauses in an idle `reviewing` state, and a human
 *      approves / edits / rejects it before anything consequential runs. This
 *      is LangGraph's "review tool calls" human-in-the-loop pattern as
 *      explicit, typed machine states.
 *   2. SDK-owned (`toolCallingMachine`, second half of this file): the request
 *      carries a real AI SDK tool and `maxSteps`, so the SDK runs the whole
 *      multi-step loop itself. The machine never sees an individual tool call —
 *      only the completed request, whose native `ModelMessage[]` response it
 *      appends through an `agent.messages` transition.
 *
 * Pick 1 when a call is consequential enough to gate; pick 2 when the loop is
 * routine and you only care about the transcript it leaves behind.
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
 *                               proposal; a further REJECT ends without executing
 *
 * The revision loop is bounded by a counter, not a flag: `revisions` is compared
 * to `MAX_REVISIONS` in the REJECT transition, so at most that many model redos
 * happen and the next reject lands in the terminal `rejected` state.
 *
 * Domain: a small ops assistant with one consequential tool, `sendRefund`,
 * executed by a typed plain actor. The default implementation just returns a
 * receipt; a host (or a test) passes its own via `runAgent({ actors })`, so
 * nothing is recorded in module-level state.
 *
 * Dual-mode: `runReviewToolCallsExample(options?)` takes an injectable
 * `generateText` (keyless tests pass a mock) plus a sequence of resume events,
 * each applied across a JSON snapshot round-trip; the direct run uses real models
 * and a readline approve/edit/reject prompt.
 *
 * Run the machine-owned variant (readline review prompt):
 *   OPENAI_API_KEY=... npx tsx examples/review-tool-calls/index.ts
 * Run the SDK-owned variant (two-turn calculator conversation):
 *   OPENAI_API_KEY=... npx tsx examples/review-tool-calls/index.ts sdk
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { tool } from "ai";
import { createAsyncLogic } from "xstate";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";
import {
  getInteraction,
  getStatePath,
  interactionMetaSchema,
  messagesSchema,
  runAgent,
  setupAgent,
  type AgentMessage,
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

/** Model redos a reviewer may trigger before REJECT becomes terminal. */
export const MAX_REVISIONS = 1;

const contextSchema = z.object({
  request: z.string(),
  // The pending proposal under review; null before the model proposes / after a
  // reject clears it for a redo.
  proposal: refundCallSchema.nullable(),
  // Last rejection feedback, fed into the next proposal.
  feedback: z.string().nullable(),
  // Why the run gave up, when it did. `null` on every reviewed path.
  failure: z.string().nullable(),
  // Bounds the redo loop: model redos a reject has triggered so far.
  revisions: z.number(),
  // Whether a human edited the args before it ran. A fact about what the
  // human did, not a mirror of a state.
  edited: z.boolean(),
});

const agentSetup = setupAgent({
  models,
  context: contextSchema,
  input: z.object({ request: z.string() }),
  output: z.object({
    executed: z.boolean(),
    call: refundCallSchema.nullable(),
    edited: z.boolean(),
    /** Set only when the proposal request failed. */
    failure: z.string().nullable(),
  }),
  // The shipped interaction protocol: the pause's `label`, a button
  // `label`/`style` per accepted event, and `textEvent` naming the ONE event
  // free text goes to.
  meta: interactionMetaSchema,
  events: {
    APPROVE: z.object({}),
    // Partial override merged over the proposal: `override` carries any subset of
    // the refund fields, validated before it can resume.
    EDIT: z.object({ override: refundCallSchema.partial() }),
    REJECT: z.object({ feedback: z.string() }),
  },
  actors: {
    // The consequential tool: applies the approved/edited refund. A real host
    // calls a payments API here by overriding this actor per run
    // (`runAgent(machine, { actors: { sendRefund } })`); the default just
    // returns the receipt, so importing this module records nothing anywhere.
    sendRefund: createAsyncLogic<RefundCall, RefundCall>({ run: async ({ input }) => input }),
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
    reviewing: { schemas: { context: contextSchema.extend({ proposal: refundCallSchema }) } },
    executing: { schemas: { context: contextSchema.extend({ proposal: refundCallSchema }) } },
  },
});

export const reviewToolCallsMachine = agentSetup.createMachine({
  id: "review-tool-calls",
  context: ({ input }) => ({
    request: input.request,
    proposal: null,
    feedback: null,
    revisions: 0,
    edited: false,
    failure: null,
  }),
  initial: "proposing",
  states: {
    // The model proposes the tool call (fresh, or a redo carrying feedback).
    proposing: {
      invoke: {
        src: "proposeRefund",
        input: ({ context }) => ({ request: context.request, feedback: context.feedback }),
        onDone: ({ output }) => ({ target: "reviewing", context: { proposal: output } }),
        // Without this the run would hang on a model error with a consequential
        // tool half-proposed. `failed` says so; it never executes anything.
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `proposeRefund failed: ${String(event.error)}` },
        }),
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
        // Bounded by a counter against a constant: up to MAX_REVISIONS redos,
        // then REJECT is terminal.
        REJECT: ({ context, event }) =>
          context.revisions >= MAX_REVISIONS
            ? { target: "rejected", context: { feedback: event.feedback } }
            : {
                target: "proposing",
                context: {
                  feedback: event.feedback,
                  revisions: context.revisions + 1,
                  proposal: null,
                },
              },
      },
    },
    // Approved/edited: the tool actually runs (the resumed tool node).
    executing: {
      invoke: {
        src: "sendRefund",
        input: ({ context }) => context.proposal,
        onDone: { target: "executed" },
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `sendRefund failed: ${String(event.error)}` },
        }),
      },
    },
    // One final state per outcome, each declaring its own output — no
    // `executed` boolean shadowing which state the machine ended in.
    executed: {
      type: "final",
      output: ({ context }) => ({
        executed: true,
        call: context.proposal,
        edited: context.edited,
        failure: null,
      }),
    },
    rejected: {
      type: "final",
      output: ({ context }) => ({
        executed: false,
        call: null,
        edited: context.edited,
        failure: null,
      }),
    },
    failed: {
      type: "final",
      output: ({ context }) => ({
        executed: false,
        call: null,
        edited: context.edited,
        failure: context.failure ?? "unknown failure",
      }),
    },
  },
});

export interface RunReviewToolCallsOptions {
  request?: string;
  /**
   * Resume events applied in order across idle settles (each via a JSON snapshot
   * round-trip). Defaults to a single APPROVE. Running out is an error, not a
   * silent replay of the last one — a script that repeats forever hides a loop
   * that never terminates.
   */
  events?: Array<
    | { type: "APPROVE" }
    | { type: "EDIT"; override: Partial<RefundCall> }
    | { type: "REJECT"; feedback: string }
  >;
  /** Injected for tests; direct run supplies a real model executor. */
  generateText?: AgentRequestExecutors["generateText"];
  /** The consequential side effect. Defaults to the machine's receipt-only actor. */
  sendRefund?: (call: RefundCall) => Promise<RefundCall>;
  /** Observes each machine transition across all runAgent calls. */
  onProgress?: (state: string) => void;
}

export interface ReviewToolCallsResult {
  executed: boolean;
  call: RefundCall | null;
  edited: boolean;
  /** Set only when a request failed and the run ended in `failed`. */
  failure: string | null;
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
    sendRefund,
    onProgress,
  } = options;
  const runOptions = {
    executors: generateText ? { generateText } : createAiSdkExecutors({ models }),
    // The side effect is the caller's: a test passes a recording one, a real
    // host passes the payments call.
    ...(sendRefund
      ? {
          actors: {
            sendRefund: createAsyncLogic<RefundCall, RefundCall>({
              run: ({ input }) => sendRefund(input),
            }),
          },
        }
      : {}),
  };

  const track = (snapshot: { value: Parameters<typeof getStatePath>[0] }) =>
    onProgress?.(getStatePath(snapshot.value));

  let result = await runAgent(reviewToolCallsMachine, {
    input: { request },
    ...runOptions,
    onTransition: track,
  });

  const proposals: RefundCall[] = [];
  let interactionLabel: string | undefined;
  let legalEvents: string[] = [];
  let i = 0;

  while (result.status === "idle") {
    if (i === 0) {
      // One call for both: the rendered label and the choices XState accepts.
      const interaction = getInteraction(result.snapshot);
      interactionLabel = interaction?.label;
      legalEvents = interaction?.events.map((choice) => choice.type) ?? [];
    }
    const proposal = result.snapshot.context.proposal;
    if (proposal) proposals.push(proposal);

    const event = events[i];
    if (!event) {
      throw new Error(
        `The machine settled idle ${i + 1} time(s) but only ${events.length} resume event(s) ` +
          "were supplied. Add one, rather than replaying the last event forever.",
      );
    }
    i++;
    result = await runAgent(reviewToolCallsMachine, {
      snapshot: result.persist(),
      event,
      ...runOptions,
      onTransition: track,
    });
  }

  if (result.status !== "done") {
    throw new Error(`Expected done after review, got '${result.status}'.`);
  }
  return { ...result.output, proposals, interactionLabel, legalEvents };
}

// ============================================================================
// Variant 2: SDK-owned tool loop
//
// The request below carries a real AI SDK tool and `maxSteps`, so the AI SDK
// executor owns every intermediate tool call. Its `ModelMessage[]` response is
// emitted as an ordinary `agent.messages` event and appended explicitly by the
// machine — the machine sees the completed request, never an individual call,
// so there is nothing for a human to gate. Compare `reviewToolCallsMachine`
// above when a call is consequential enough to review first.
//
// The conversation runs more than one turn on purpose: after each answer the
// run settles idle in `waiting`, and the next question is appended to the SAME
// transcript. A follow-up like "and that plus 8" only works because the
// retained tool-call and tool-result messages go back to the model.
// ============================================================================

/** Questions one conversation may ask before only END stays legal. */
export const MAX_TURNS = 4;

/**
 * The library's `messagesSchema` really validates roles, parts and media
 * payloads — far more than a `z.custom(Array.isArray)` would. It is a Standard
 * Schema rather than a zod one, so `z.object` cannot take it as a field
 * directly; this adapter delegates to it.
 */
const messagesField = z.custom<AgentMessage[]>(
  (value) => !("issues" in messagesSchema["~standard"].validate(value)),
  { message: "Expected an array of agent messages" },
);

const toolCallingSetup = setupAgent({
  models,
  meta: interactionMetaSchema,
  context: z.object({
    answer: z.string().nullable(),
    messages: messagesField,
    turns: z.number().int(),
  }),
  input: z.object({ question: z.string() }),
  output: z.object({
    status: z.enum(["answered", "failed"]),
    answer: z.string().nullable(),
    messages: messagesField,
  }),
  events: {
    /** The human's next question, appended to the retained transcript. */
    ASK: z.object({ question: z.string() }),
    /** The human is finished. */
    END: z.object({}),
  },
  requests: {
    answer: {
      model: "assistant",
      schemas: {
        input: z.object({ messages: messagesField }),
        output: z.string(),
      },
      system: "Use the calculator when arithmetic is requested, then answer concisely.",
      messages: ({ input }) => input.messages,
      tools: {
        calculate: tool({
          description: "Add or multiply two numbers.",
          inputSchema: z.object({
            operation: z.enum(["add", "multiply"]),
            a: z.number(),
            b: z.number(),
          }),
          execute: async ({ operation, a, b }) => ({
            value: operation === "add" ? a + b : a * b,
          }),
        }),
      },
      maxSteps: 5,
    },
  },
});

export const toolCallingMachine = toolCallingSetup.createMachine({
  id: "tool-calling",
  context: ({ input }) => ({
    answer: null,
    messages: [{ role: "user", content: input.question }],
    turns: 0,
  }),
  initial: "answering",
  // Transcript retention is visible machine behavior, not runner side state.
  on: {
    "agent.messages": toolCallingSetup.appendMessages(),
  },
  states: {
    answering: {
      invoke: {
        src: "answer",
        input: ({ context }) => ({ messages: context.messages }),
        onDone: ({ context, output }) => ({
          target: "waiting",
          context: { answer: output, turns: context.turns + 1 },
        }),
        onError: { target: "failed" },
      },
    },
    // No invoke: the run settles idle here with the transcript so far.
    waiting: {
      tags: ["waiting"],
      meta: {
        interaction: {
          label: "Ask a follow-up, or end the conversation.",
          textEvent: "ASK",
          events: { END: { label: "End", style: "default" } },
        },
      },
      on: {
        // Past the turn budget ASK is illegal, so END is the only way on.
        ASK: ({ context, event }) =>
          context.turns >= MAX_TURNS
            ? undefined
            : {
                target: "answering",
                context: {
                  messages: [...context.messages, { role: "user", content: event.question }],
                },
              },
        END: { target: "done" },
      },
    },
    done: {
      type: "final",
      output: ({ context }) => ({
        status: "answered" as const,
        answer: context.answer,
        messages: context.messages,
      }),
    },
    failed: {
      type: "final",
      output: ({ context }) => ({
        status: "failed" as const,
        answer: null,
        messages: context.messages,
      }),
    },
  },
});

/**
 * Runs one conversation: the first question, then each follow-up resumed from
 * the persisted idle snapshot, then END.
 */
export async function runToolCallingExample(
  question: string,
  options: {
    followUps?: string[];
    executors?: AgentRequestExecutors;
  } = {},
) {
  const executors = options.executors ?? createAiSdkExecutors({ models });
  const answers: string[] = [];

  let result = await runAgent(toolCallingMachine, { input: { question }, executors });
  // A failed request ends the run in `failed` with nothing to follow up on.
  if (result.status === "done") return { ...result.output, answers };
  for (const followUp of options.followUps ?? []) {
    if (result.status !== "idle") break;
    answers.push(result.snapshot.context.answer ?? "");
    result = await runAgent(toolCallingMachine, {
      snapshot: result.persist(),
      event: { type: "ASK", question: followUp },
      executors,
    });
  }

  if (result.status !== "idle") {
    throw new Error(`Tool call ended with '${result.status}'.`);
  }
  answers.push(result.snapshot.context.answer ?? "");

  const ended = await runAgent(toolCallingMachine, {
    snapshot: result.persist(),
    event: { type: "END" },
    executors,
  });
  if (ended.status !== "done") throw new Error(`Tool call ended with '${ended.status}'.`);
  return { ...ended.output, answers };
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

// Run directly (`tsx index.ts`, or `tsx index.ts sdk` for the SDK-owned
// variant); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  void (async () => {
    if (process.argv[2] === "sdk") {
      const conversation = await runToolCallingExample("What is 6 times 7?", {
        followUps: ["And what is that plus 8?"],
      });
      console.log(conversation.answers.join("\n"));
      console.log(`\n${conversation.messages.length} retained messages.`);
      return;
    }

    const executors = createAiSdkExecutors({ models });
    const request = "Customer #A-1000 was double-charged $20 on order ORD-42. Make it right.";

    let result = await runAgent(reviewToolCallsMachine, {
      input: { request },
      executors,
      onTransition: (snapshot) => console.log(`  → ${getStatePath(snapshot)}`),
    });

    while (result.status === "idle") {
      const snapshot = result.snapshot;
      const proposal = snapshot.context.proposal;
      const interaction = getInteraction(snapshot);

      console.log("\n--- Proposed tool call: sendRefund ---");
      console.log(JSON.stringify(proposal, null, 2));
      console.log(interaction?.label ?? "");
      console.log("Legal events:", interaction?.events.map((c) => c.type).join(", "));

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
        onTransition: (snapshot) => console.log(`  → ${getStatePath(snapshot)}`),
      });
    }

    if (result.status !== "done") {
      throw new Error(`Review did not complete: ${result.status}`);
    }
    console.log("\n--- Result ---");
    console.log(
      result.output.executed
        ? `Executed (${result.output.edited ? "edited" : "as proposed"}): ${JSON.stringify(result.output.call)}`
        : (result.output.failure ?? "Not executed (rejected)."),
    );
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
