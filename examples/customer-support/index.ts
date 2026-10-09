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
 *   classifying → routing → (answering ⇄ awaitingInfo | confirming → executing/denied)
 *
 *   - Non-sensitive Q&A: ONE `answer` request carries real `tools`
 *     (`lookupBooking`, `searchPolicies` over a small sample table) and the host
 *     runs the tool loop, bounded by the request's `maxSteps`. The machine never sees
 *     the intermediate tool calls — same as LangGraph's safe-tools path, minus
 *     the extra node. (See examples/tool-calling.)
 *   - Intent routing as a JUDGMENT that SELECTS instead of generating. `classify`
 *     is ONE call to the AI SDK's `experimental_decide` with Jev
 *     (`@ai-sdk/typesafe-ai`) as the decision model, over `{ message,
 *     knownCodes, flights }`, where code pre-parses the candidates first: `knownCodes` are
 *     the confirmation-code-shaped spans in the message (`findCodeCandidates`),
 *     and `flights` are the sample schedule's alternatives for the bookings
 *     those codes name (`FLIGHTS`). Jev answers a `choice` for `intent`
 *     (question | cancel | rebook), a `choice` for `newFlight` over the flight
 *     ids plus `none`, and — only when there is more than one candidate code —
 *     a `choice` for `confirmationCode` over the candidates plus `none` (one
 *     candidate: code takes it; none: null). So "the morning flight" resolves
 *     to a concrete flight by selection, and a confirmation code is always a
 *     verbatim span of the message: Jev cannot invent either. A `choice` state
 *     then routes on the staged action — the typed analogue of `route_tools`.
 *     A sensitive intent without a code or a target flight ends in `failed`
 *     with a message saying what was missing, never at the approval gate.
 *   - TWO KINDS OF PAUSE, and the machine tells them apart. `confirming` blocks
 *     a write until a human approves it. `awaitingInfo` blocks an ANSWER until
 *     the customer supplies something only they know — which booking, which
 *     flight. Both are idle states with no invoke, and the difference matters:
 *     a bot that replies "send me your confirmation code" has not answered
 *     anything, and a turn that reports `answered` there has lied about its own
 *     outcome. The `answer` request returns a discriminated union —
 *     `{ status: 'answered', answer }` or `{ status: 'needsInfo', question }` —
 *     so the distinction is data the machine routes on, not a sentence a human
 *     has to read. Asking is bounded by MAX_CLARIFICATIONS; past it the turn ends
 *     `unresolved` with the question still outstanding.
 *   - Sensitive action: instead of an `interrupt_before` flag, the machine
 *     *transitions into an idle `confirming` state* — no invoke, tags
 *     `['awaiting-approval']`, a static `meta.interaction` label, and the pending
 *     action in `context.pendingAction`. The run settles `{ status: 'idle',
 *     snapshot }` once nothing is in flight, so pausing is a first-class machine
 *     state, not a host-side `snapshot.next` check. The host persists the
 *     snapshot and resumes with an APPROVE or DENY event in a *second* run. (See
 *     examples/human-in-the-loop.)
 *
 * Dual-mode: `runCustomerSupportExample(options?)` takes an injectable
 * `generateText` and `judge` (tests with no API key pass mocks); the direct
 * run uses real models and a readline approve/deny prompt.
 *
 * Run: OPENAI_API_KEY=... TYPESAFE_AI_API_KEY=... npx tsx examples/customer-support/index.ts
 */
import { z } from "zod";
import { experimental_decide, tool, type Experimental_DecisionModel } from "ai";
import { openai } from "@ai-sdk/openai";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import { createAsyncLogic, type StateValue } from "xstate";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import {
  getAcceptedEvents,
  getInteraction,
  getStatePath,
  interactionMetaSchema,
  createAgentRuntime,
  runToQuiescence,
  setupAgent,
  type AgentRequestExecutors,
} from "@statelyai/agent";

const models = {
  assistant: openai("gpt-5.4-mini"),
};

// ─── sample data (stand-ins for the tutorial's SQLite airline DB) ───

export interface Booking {
  passenger: string;
  flight: string;
  status: "confirmed" | "cancelled";
}

/**
 * A tiny booking table, keyed by confirmation code — the stand-in for the
 * tutorial's SQLite database, and the state `executeAction` really writes to.
 * Approving a cancellation flips the stored `status`; call
 * {@link resetBookings} between runs to get the fixture back.
 */
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
  // The code the "cancel my flight" starter quotes — seeded so the advertised
  // starter actually cancels a booking instead of reporting "no booking found".
  "7QX2P": {
    passenger: "Grace Hopper",
    flight: "UA918 SFO→NRT, 2026-10-03 11:05",
    status: "confirmed",
  },
};

const INITIAL_BOOKINGS: Record<string, Booking> = structuredClone(BOOKINGS);

/** Restores the fixture table, so one run's approved cancellation cannot leak into the next. */
export function resetBookings(): void {
  for (const key of Object.keys(BOOKINGS)) delete BOOKINGS[key];
  Object.assign(BOOKINGS, structuredClone(INITIAL_BOOKINGS));
}

/** A tiny policy table (stand-in for LangGraph's `lookup_policy` retriever). */
export const POLICIES: Record<string, string> = {
  cancellation:
    "Economy tickets are refundable up to 24 hours before departure; after that a $150 fee applies.",
  baggage:
    "One carry-on and one personal item are included. Checked bags are $40 each, up to three.",
  changes: "Flight changes incur a $75 fee plus any fare difference, subject to seat availability.",
};

/**
 * A tiny flight schedule: the alternatives a rebook can move a booking onto
 * (the tutorial's `search_flights` table, cut down). The rebook path SELECTS
 * one of these; it never writes a flight the schedule does not list.
 */
export const FLIGHTS: Array<{ id: string; route: string; departs: string }> = [
  { id: "BA247", route: "LHR→GRU", departs: "2026-08-03 21:30" },
  { id: "BA251", route: "LHR→GRU", departs: "2026-08-02 09:40" },
  { id: "AA106", route: "JFK→LHR", departs: "2026-09-14 09:00" },
  { id: "AA104", route: "JFK→LHR", departs: "2026-09-15 18:15" },
  { id: "UA916", route: "SFO→NRT", departs: "2026-10-03 07:00" },
  { id: "UA920", route: "SFO→NRT", departs: "2026-10-04 11:05" },
];

/** A schedule row in the booking table's `flight` format. */
function flightLabel(flight: { id: string; route: string; departs: string }): string {
  return `${flight.id} ${flight.route}, ${flight.departs}`;
}

// ─── pre-parsing: code finds the candidates, Jev picks among them ───

/**
 * Confirmation-code candidates: PNR-like spans (5–6 capitals/digits with at
 * least one digit, so shouted words like "CANCEL" never match), deduplicated,
 * in message order. Recall-tuned on purpose: a flight number like "AA106"
 * also matches, and Jev decides which span is the confirmation code.
 */
export function findCodeCandidates(message: string): string[] {
  return [...new Set(message.match(/\b(?=[A-Z0-9]*\d)[A-Z0-9]{5,6}\b/g) ?? [])];
}

/**
 * The flights a rebook may select: the schedule's alternatives on the route of
 * any booking a candidate code names, or the whole schedule when no candidate
 * names a known booking.
 */
export function flightCandidates(knownCodes: string[]): typeof FLIGHTS {
  const booked = knownCodes.flatMap((code) => BOOKINGS[code] ?? []);
  if (booked.length === 0) return FLIGHTS;
  return FLIGHTS.filter((flight) =>
    booked.some(
      (booking) => booking.flight.includes(flight.route) && booking.flight !== flightLabel(flight),
    ),
  );
}

/** Label for "no candidate fits" in the two selection questions. */
const NONE = "none";

/**
 * The judge: TypeSafe's Jev through the AI SDK's decision-model provider.
 * Reads `TYPESAFE_AI_API_KEY`. Tests pass a mock decision model instead.
 */
const judgeModel: Experimental_DecisionModel = typeSafeAi.decisionModel("jev-latest");

/**
 * `classify` as ONE `experimental_decide` call: the message and the
 * pre-parsed candidates are the state; `intent`, `newFlight`, and (with 2+
 * candidates) `confirmationCode` are `choice` questions whose labels ARE the
 * candidates. The judge model is injected by tests and hosts; the default is
 * Jev.
 */
export function createClassify(model: Experimental_DecisionModel = judgeModel) {
  return createAsyncLogic<
    {
      answers: {
        intent: { choice: "question" | "cancel" | "rebook" };
        newFlight: { choice: string };
        confirmationCode?: { choice: string };
      };
    },
    { query: string }
  >({
    run: async ({ input, signal }) => {
      const knownCodes = findCodeCandidates(input.query);
      const flights = flightCandidates(knownCodes);
      const questions = {
        intent: {
          type: "choice" as const,
          instructions: "What is the customer asking the airline assistant to do in `message`?",
          criteria: {
            question:
              "Anything answerable from bookings or policies: fees, baggage, what their flight " +
              "is. Also anything that does not explicitly ask to change a booking.",
            cancel: "Explicitly asks to cancel a booking.",
            rebook: "Explicitly asks to move a booking to a different flight.",
          },
        },
        newFlight: {
          type: "choice" as const,
          instructions: "Which flight in `flights` does `message` ask to move the booking to?",
          criteria: {
            ...Object.fromEntries(
              flights.map((flight) => [flight.id, `${flight.route}, departs ${flight.departs}`]),
            ),
            [NONE]: "The message names no new flight, or none of these fits it.",
          },
        },
      };
      const { answers } = await experimental_decide({
        model,
        state: { message: input.query, knownCodes, flights },
        questions:
          knownCodes.length > 1
            ? {
                ...questions,
                confirmationCode: {
                  type: "choice" as const,
                  instructions:
                    "Which of `knownCodes` is the booking confirmation code in `message`?",
                  criteria: {
                    ...Object.fromEntries(knownCodes.map((code) => [code, null])),
                    [NONE]:
                      "None of these is a booking confirmation code (e.g. all are flight numbers).",
                  },
                },
              }
            : questions,
        abortSignal: signal,
      });
      return { answers };
    },
  });
}

/**
 * Maps the answers back onto the candidates code found: the pending action for
 * a sensitive intent, `null` for a question, or what was missing.
 */
function stageAction(
  query: string,
  answers: {
    intent: { choice: string };
    newFlight: { choice: string };
    confirmationCode?: { choice: string };
  },
): { pendingAction: PendingAction | null } | { missing: string } {
  const intent = answers.intent.choice;
  if (intent !== "cancel" && intent !== "rebook") return { pendingAction: null };
  const candidates = findCodeCandidates(query);
  const picked =
    candidates.length === 1 ? candidates[0]! : (answers.confirmationCode?.choice ?? NONE);
  if (picked === NONE || !candidates.includes(picked)) {
    return { missing: "Could not find a confirmation code in the request." };
  }
  if (intent === "cancel") {
    return {
      pendingAction: {
        type: "cancel",
        confirmationCode: picked,
        newFlight: null,
        summary: `Cancel booking ${picked}`,
      },
    };
  }
  const flight = FLIGHTS.find((row) => row.id === answers.newFlight.choice);
  if (!flight) return { missing: "Could not tell which scheduled flight to move the booking to." };
  const newFlight = flightLabel(flight);
  return {
    pendingAction: {
      type: "rebook",
      confirmationCode: picked,
      newFlight,
      summary: `Rebook ${picked} onto ${newFlight}`,
    },
  };
}

// ─── schemas ───

// The pending sensitive action, held in context while the machine waits idle for
// approval (the dynamic detail behind the static `meta.interaction` label).
const pendingActionSchema = z.object({
  type: z.enum(["cancel", "rebook"]),
  confirmationCode: z.string(),
  newFlight: z.string().nullable(),
  summary: z.string(),
});
export type PendingAction = z.infer<typeof pendingActionSchema>;

const resolutionSchema = z.enum(["answered", "executed", "denied", "failed", "unresolved"]);

/**
 * What one answer attempt produced. Answering and asking are different shapes,
 * so the machine routes on the branch rather than on a flag the model might
 * set carelessly.
 */
const answerSchema = z.union([
  z.object({ status: z.literal("answered"), answer: z.string() }),
  z.object({ status: z.literal("needsInfo"), question: z.string() }),
]);

const contextSchema = z.object({
  query: z.string(),
  pendingAction: pendingActionSchema.nullable(),
  /** Details the customer supplied when asked — a confirmation code, which
   * flight — appended in order and fed back into the next answer attempt. */
  details: z.array(z.string()),
  /** Questions asked so far, so the bot cannot interrogate forever. */
  clarifications: z.number(),
  maxClarifications: z.number(),
  // The one line this turn will report, whichever way it ends. Which final
  // state was reached IS the resolution — no mirror of it lives here.
  message: z.string(),
});

const agentSetup = setupAgent({
  models,
  context: contextSchema,
  input: z.object({ query: z.string() }),
  output: z.object({ resolution: resolutionSchema, message: z.string() }),
  // The library's interaction protocol: the pause's `label`, a button
  // `label`/`style` per accepted event, and `textEvent` naming the ONE event
  // free text goes to.
  meta: interactionMetaSchema,
  events: {
    APPROVE: z.object({}),
    DENY: z.object({ reason: z.string() }),
    /** The detail the bot asked for. */
    PROVIDE_INFO: z.object({ text: z.string() }),
    /** The customer would rather not say. */
    STOP_ASKING: z.object({}),
  },
  actors: {
    // Intent routing + argument selection: one Jev call (see createClassify).
    classify: createClassify(),
    // Applies the approved sensitive action: it WRITES to the booking table,
    // it does not merely describe the write. (A production host would hit its
    // database here — see the tutorial's cancel_ticket.) A missing booking is
    // an error, so the machine can route it to `failed` instead of reporting a
    // change that never happened.
    executeAction: createAsyncLogic<string, PendingAction>({
      run: async ({ input }) => {
        const booking = BOOKINGS[input.confirmationCode];
        if (!booking) {
          throw new Error(`No booking found for ${input.confirmationCode}; nothing changed.`);
        }
        if (input.type === "cancel") {
          const previousFlight = booking.flight;
          booking.status = "cancelled";
          return `Booking ${input.confirmationCode} (${previousFlight}) is now cancelled. A refund will follow per policy.`;
        }
        const previousFlight = booking.flight;
        booking.flight = input.newFlight ?? booking.flight;
        return `Booking ${input.confirmationCode} moved from ${previousFlight} to ${booking.flight}. A $75 change fee applies.`;
      },
    }),
  },
  requests: {
    // Safe Q&A: one request, real read-only tools, host-run tool loop.
    answer: {
      schemas: {
        input: z.object({ query: z.string(), details: z.array(z.string()) }),
        // A discriminated union: a branch the model has to NAME is far harder to get wrong than a
        // boolean sitting beside free text. With a `{ needsInfo, text }` pair
        // the model cheerfully reported `needsInfo: false` while `text` asked
        // for a confirmation code — and the turn settled `answered` having
        // answered nothing. Here there is nowhere to put a question except
        // the branch called `question`.
        output: answerSchema,
      },
      model: "assistant",
      system:
        "You are an airline support agent. Use lookupBooking to read a booking " +
        "by confirmation code, and searchPolicies for fees, baggage, " +
        "cancellation, or change rules.\n" +
        "Baggage allowances, fees, and cancellation or change rules are the " +
        'same on every ticket, so "my ticket" needs no booking: call ' +
        "searchPolicies first and answer from it — never ask which booking.\n" +
        "Return { status: 'answered', answer } when you can answer, in one or " +
        "two friendly sentences. An answer is complete on its own: it never " +
        "asks the customer for anything (no confirmation code, no 'let me " +
        "know'), because the turn ends there and they cannot reply.\n" +
        "Return { status: 'needsInfo', question } only when the answer really " +
        "depends on a detail only the customer has — which booking, which " +
        "flight. Anything you would end by asking the customer for something " +
        "belongs in this branch, never in `answer`. Never ask for what the " +
        "tools can tell you.",
      prompt: ({ input }) =>
        [
          input.query,
          ...input.details.map(
            (detail, index) => `Detail ${index + 1} from the customer: ${detail}`,
          ),
        ].join("\n"),
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
          description:
            "Look up an airline policy by topic (cancellation, baggage, changes). " +
            "Policies apply to every ticket; no booking is needed.",
          inputSchema: z.object({ topic: z.enum(["cancellation", "baggage", "changes"]) }),
          execute: async ({ topic }) => ({ topic, text: POLICIES[topic] }),
        }),
      },
      // Bound the host-side tool loop (the AI SDK adapter reads this).
      maxSteps: 5,
    },
  },
  // `confirming` and `executing` are reached only after classify set a sensitive
  // `pendingAction` — narrow it non-null there so the invoke input type-checks.
  states: {
    confirming: {
      schemas: { context: contextSchema.extend({ pendingAction: pendingActionSchema }) },
    },
    executing: {
      schemas: { context: contextSchema.extend({ pendingAction: pendingActionSchema }) },
    },
  },
});

/** Questions the bot may ask before it answers with whatever it has. */
export const MAX_CLARIFICATIONS = 2;

export const customerSupportMachine = agentSetup.createMachine({
  id: "customer-support",
  context: ({ input }) => ({
    query: input.query,
    pendingAction: null,
    details: [],
    clarifications: 0,
    maxClarifications: MAX_CLARIFICATIONS,
    message: "",
  }),
  initial: "classifying",
  states: {
    // Classify intent, and (for sensitive intents) stage the pending action.
    classifying: {
      invoke: {
        src: "classify",
        input: ({ context }) => ({ query: context.query }),
        // Map the selections back onto the candidates. A sensitive intent
        // missing its code or target flight never reaches the approval gate.
        onDone: ({ context, output }) => {
          const staged = stageAction(context.query, output.answers);
          return "missing" in staged
            ? { target: "failed", context: { message: staged.missing } }
            : { target: "routing", context: { pendingAction: staged.pendingAction } };
        },
        onError: {
          target: "failed",
          context: { message: "Could not classify the request." },
        },
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
        input: ({ context }) => ({ query: context.query, details: context.details }),
        // "I need your confirmation code" is not an answer. Routed on the
        // request's own `needsInfo` flag, it becomes a state the customer can
        // reply into — instead of a final state that reports `answered`
        // having answered nothing.
        onDone: ({ context, output: { result: output } }) => {
          if (output.status === "answered") {
            return { target: "answered", context: { message: output.answer } };
          }
          // Bounded: past the budget the bot stops asking and says what it can.
          if (context.clarifications >= context.maxClarifications) {
            return { target: "unresolved", context: { message: output.question } };
          }
          return { target: "awaitingInfo", context: { message: output.question } };
        },
        onError: {
          target: "failed",
          context: { message: "Could not answer this question." },
        },
      },
    },
    // The OTHER kind of human pause. `confirming` asks permission to act;
    // this asks for something only the customer knows. Both are idle states
    // with no invoke, and telling them apart in the machine is the whole
    // point: one blocks a write, the other blocks an answer.
    awaitingInfo: {
      tags: ["awaiting-info"],
      meta: {
        interaction: {
          // `{message}` resolves against the snapshot's context, so the label
          // IS the question the agent just asked.
          label: "{message}",
          events: {
            STOP_ASKING: { label: "I'd rather not say", style: "danger" },
          },
          textEvent: "PROVIDE_INFO",
        },
      },
      on: {
        PROVIDE_INFO: ({ context, event }) => ({
          target: "answering",
          context: {
            details: [...context.details, event.text],
            clarifications: context.clarifications + 1,
          },
        }),
        STOP_ASKING: { target: "unresolved" },
      },
    },
    answered: {
      type: "final",
      output: ({ context }) => ({ resolution: "answered" as const, message: context.message }),
    },
    // The turn ends with a question outstanding, and says so. Reporting this
    // as `answered` is what made the old run look like it had helped.
    unresolved: {
      type: "final",
      output: ({ context }) => ({ resolution: "unresolved" as const, message: context.message }),
    },
    // Sensitive path, gate: no invoke → `runAgent` settles idle here. The host
    // reads `meta.interaction` (static label) + `context.pendingAction` (the
    // specifics) and legal events from `getAcceptedEvents(snapshot)`. This is
    // the `interrupt_before=["sensitive_tools"]` pause, as an explicit state.
    confirming: {
      tags: ["awaiting-approval"],
      meta: {
        interaction: {
          label:
            "This action modifies a booking and needs your approval. " +
            "Approve it, or type a reason to skip it.",
          events: {
            APPROVE: { label: "Approve booking change", style: "primary" },
            DENY: { label: "Skip this action", style: "danger" },
          },
          // Without this, free text would silently DENY (its `reason` is the
          // only single-string payload here).
          textEvent: "DENY",
        },
      },
      on: {
        APPROVE: { target: "executing" },
        // LangGraph's denial feeds a `ToolMessage` reason back to the model;
        // here the reason is captured on the DENY event and the machine finishes
        // without touching the booking.
        DENY: ({ event }) => ({
          target: "denied",
          context: { message: `Action skipped at your request. Reason: ${event.reason}` },
        }),
      },
    },
    // Approved: now the sensitive action actually runs (the resumed
    // `sensitive_tools` node).
    executing: {
      invoke: {
        src: "executeAction",
        input: ({ context }) => context.pendingAction,
        onDone: ({ output }) => ({ target: "executed", context: { message: output } }),
        // The booking table refused the write (no such booking): say so instead
        // of reporting a change that never happened.
        onError: ({ event }) => ({
          target: "failed",
          // `event.error` is `unknown` — narrow it rather than asserting it is
          // an `Error`, since a thrown string reaches here just as easily.
          context: {
            message: event.error instanceof Error ? event.error.message : String(event.error),
          },
        }),
      },
    },
    executed: {
      type: "final",
      output: ({ context }) => ({ resolution: "executed" as const, message: context.message }),
    },
    denied: {
      type: "final",
      output: ({ context }) => ({ resolution: "denied" as const, message: context.message }),
    },
    // Nothing was changed and nothing was answered.
    failed: {
      type: "final",
      output: ({ context }) => ({ resolution: "failed" as const, message: context.message }),
    },
  },
});

export interface RunCustomerSupportOptions {
  query?: string;
  /** For the sensitive path: approve (default) or deny the pending action. */
  approve?: boolean;
  /** Reason attached to a DENY (the tutorial's denial explanation). */
  denyReason?: string;
  /** Answers to the bot's questions, in order. Running out declines to say more. */
  replies?: string[];
  /** Injected for tests; direct run supplies a real model executor. */
  generateText?: AgentRequestExecutors["generateText"];
  /** The judge model; tests pass a mock, the direct run uses Jev. */
  judge?: Experimental_DecisionModel;
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
 * Runs one support turn across as many `runAgent` calls as the turn needs.
 * A direct answer finishes in one. A sensitive query settles idle at
 * `confirming` and resumes with APPROVE or DENY. A question the bot cannot
 * answer alone settles idle at `awaitingInfo` and resumes with the detail it
 * asked for — as many times as it asks, until the machine's own budget stops
 * it. Every leg persists and JSON-round-trips the snapshot.
 */
export async function runCustomerSupportExample(
  options: RunCustomerSupportOptions = {},
): Promise<CustomerSupportResult> {
  const {
    query = "What's the baggage policy?",
    approve = true,
    denyReason = "Changed my mind.",
    generateText,
    judge,
    onProgress,
  } = options;
  const executors = {
    ...(generateText
      ? { executors: { generateText } }
      : { executors: createAiSdkExecutors({ models }) }),
    ...(judge ? { actors: { classify: createClassify(judge) } } : {}),
  };

  const progress: string[] = [];
  const track = (snapshot: { value: StateValue }) => {
    const state = getStatePath(snapshot);
    progress.push(state);
    onProgress?.(state);
  };

  // Phase 1: classify, then either answer (done) or settle idle.
  let first = await runToQuiescence(
    createAgentRuntime(customerSupportMachine, {
      ...executors,
      onTransition: track,
    }),
    {
      input: { query },
      ...executors,
    },
  );

  // Every question the bot asks is another leg. The machine decides when to
  // stop asking; the host only decides what to say.
  const pending = [...(options.replies ?? [])];
  while (first.status === "idle" && first.snapshot.hasTag("awaiting-info")) {
    const reply = pending.shift();
    first = await runToQuiescence(
      createAgentRuntime(customerSupportMachine, {
        ...executors,
        onTransition: track,
      }),
      {
        snapshot: first.persist(),
        event:
          reply === undefined ? { type: "STOP_ASKING" } : { type: "PROVIDE_INFO", text: reply },
        ...executors,
      },
    );
  }

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
  const interaction = getInteraction(first.snapshot);
  const legalEvents = getAcceptedEvents(first.snapshot).map((event) => event.type);
  const pendingAction = first.snapshot.context.pendingAction ?? undefined;

  // Phase 2: ...later, new process, human decided. Same machine, one event,
  // resumed from the persisted (JSON-round-tripped) snapshot.
  const event = approve
    ? ({ type: "APPROVE" } as const)
    : ({ type: "DENY", reason: denyReason } as const);
  const second = await runToQuiescence(
    createAgentRuntime(customerSupportMachine, {
      ...executors,
      onTransition: track,
    }),
    {
      snapshot: first.persist(),
      event,
      ...executors,
    },
  );
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
  if (!process.env.OPENAI_API_KEY || !process.env.TYPESAFE_AI_API_KEY) {
    console.error("Set OPENAI_API_KEY and TYPESAFE_AI_API_KEY to run this example.");
    process.exit(1);
  }
  void (async () => {
    const executors = createAiSdkExecutors({ models });

    const query =
      (await promptLine("Ask the airline bot (blank = cancel AB1234) > ")) ||
      "Please cancel my booking AB1234.";

    let result = await runToQuiescence(
      createAgentRuntime(customerSupportMachine, {
        executors,
        onTransition: (snapshot) => console.log(`  → ${getStatePath(snapshot)}`),
      }),
      {
        input: { query },
      },
    );

    // Two kinds of pause, so two kinds of prompt: `confirming` wants a
    // decision about a write, `awaitingInfo` wants a detail only the customer
    // has. Asking to approve something in the second case sends an event the
    // state does not accept, and the turn never finishes.
    while (result.status === "idle") {
      const snapshot = result.snapshot;
      const interaction = getInteraction(snapshot);
      const legalEvents = getAcceptedEvents(snapshot).map((event) => event.type);
      const persisted = result.persist();

      let event: { type: string } & Record<string, unknown>;
      if (snapshot.hasTag("awaiting-info")) {
        console.log("\n--- More information needed ---");
        console.log(interaction?.label ?? "");
        console.log("Legal events:", legalEvents.join(", "));
        const detail = await promptLine("your answer (blank = decline) > ");
        event = detail ? { type: "PROVIDE_INFO", text: detail } : { type: "STOP_ASKING" };
      } else {
        console.log("\n--- Approval required ---");
        console.log("Pending action:", snapshot.context.pendingAction?.summary);
        console.log(interaction?.label ?? "");
        console.log("Legal events:", legalEvents.join(", "));
        const answer = (await promptLine("approve / deny? ")).toLowerCase();
        event = answer.startsWith("a")
          ? { type: "APPROVE" }
          : { type: "DENY", reason: await promptLine("Reason: ") };
      }

      result = await runToQuiescence(
        createAgentRuntime(customerSupportMachine, {
          executors,
          onTransition: (snapshot) => console.log(`  → ${getStatePath(snapshot)}`),
        }),
        {
          snapshot: persisted,
          event: event as never,
        },
      );
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
