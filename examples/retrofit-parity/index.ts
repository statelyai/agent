/**
 * AFTER: the `before.ts` loop as an agent machine, checked against the loop
 * two ways, with no API key:
 *
 *   1. Recorded effects. `recordLoop` runs the loop on a stand-in model
 *      (`MockLanguageModelV3` from `ai/test`) under `createRecorder`: every
 *      model call, every tool call, and the result. `replayMachine` runs the
 *      machine against that recording, and `compareRecordings` lists every
 *      effect that differs.
 *   2. Outcomes. `compareRuns` runs both on fresh worlds and labels each
 *      scenario `same`, `intended`, or `regression`.
 *
 * What moved where:
 *   - `for (step < MAX_STEPS)` → the `checkingSteps` choice state
 *   - `generateText` → the `assist` request; the executor is the loop's call
 *   - "refund ≤ order total", a prompt line → the `checkingRefund` choice state
 *   - `await approve(...)` → the idle `awaitingApproval` state, now only above
 *     APPROVAL_THRESHOLD (the one reviewed difference, see index.test.ts)
 *   - `issueRefund` → an actor only `refunding` invokes, behind a sentinel
 */
import { generateText, stepCountIs, type LanguageModel, type ModelMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createAsyncLogic } from "xstate";
import { z } from "zod";
import {
  interactionMetaSchema,
  runAgent,
  setupAgent,
  type AgentRequestExecutors,
} from "@statelyai/agent";
import {
  compareRecordings,
  compareRuns,
  createRecorder,
  type EquivalenceReport,
  type ParityReport,
  type ParityRun,
  type Recording,
} from "@statelyai/agent/testing";
import {
  createTools,
  createWorld,
  MAX_STEPS,
  orderSchema,
  refundSchema,
  runRefundLoop,
  SYSTEM,
  type Order,
  type Refund,
  type RefundRequest,
  type RefundResult,
  type SupportTools,
} from "./before.js";

/** Refunds above this need a person. The loop asked for every refund. */
export const APPROVAL_THRESHOLD = 50;

const messagesField = z.array(z.custom<ModelMessage>());

const agentSetup = setupAgent({
  actors: {
    // A placeholder; `runRefundMachine` passes the real tool.
    issueRefund: createAsyncLogic<{ refundId: string }, Refund>({
      run: async () => {
        throw new Error("issueRefund is provided at run time");
      },
    }),
  },
  context: z.object({
    ticket: z.string(),
    messages: messagesField,
    orders: z.record(z.string(), orderSchema),
    refund: refundSchema.nullable(),
    reply: z.string(),
    steps: z.number(),
  }),
  input: z.object({ ticket: z.string() }),
  output: z.object({
    outcome: z.enum(["answered", "refunded", "declined", "step-limit"]),
    reply: z.string(),
  }),
  events: { APPROVE: {}, REJECT: {} },
  meta: interactionMetaSchema,
  requests: {
    assist: {
      model: "support",
      schemas: {
        input: z.object({ messages: messagesField }),
        output: z.object({
          text: z.string(),
          calledTools: z.boolean(),
          messages: messagesField,
          lookups: z.array(orderSchema),
          refund: refundSchema.nullable(),
        }),
      },
      system: SYSTEM,
      messages: ({ input }) => input.messages,
    },
  },
});

/** The rule the loop kept only in its prompt. */
export function withinOrderTotal(orders: Record<string, Order>, refund: Refund | null): boolean {
  const order = refund ? orders[refund.orderId] : undefined;
  return refund !== null && order !== undefined && refund.amount <= order.total;
}

export const refundLoopMachine = agentSetup.createMachine({
  id: "refund-loop",
  version: "1",
  context: ({ input }) => ({
    ticket: input.ticket,
    messages: [{ role: "user" as const, content: input.ticket }],
    orders: {},
    refund: null,
    reply: "",
    steps: 0,
  }),
  initial: "checkingSteps",
  states: {
    checkingSteps: {
      type: "choice",
      choice: ({ context }) =>
        context.steps >= MAX_STEPS ? { target: "stepLimit" } : { target: "assisting" },
    },
    assisting: {
      invoke: {
        src: "assist",
        input: ({ context }) => ({ messages: context.messages }),
        onDone: ({ context, output }) => {
          const { text, calledTools, messages, lookups, refund } = output.result;
          const next = {
            messages: [...context.messages, ...messages],
            orders: {
              ...context.orders,
              ...Object.fromEntries(lookups.map((o) => [o.orderId, o])),
            },
            steps: context.steps + 1,
          };
          if (refund) return { target: "checkingRefund", context: { ...next, refund } };
          if (calledTools) return { target: "checkingSteps", context: next };
          return { target: "answered", context: { ...next, reply: text } };
        },
      },
    },
    checkingRefund: {
      type: "choice",
      choice: ({ context }) =>
        !withinOrderTotal(context.orders, context.refund)
          ? { target: "declined" }
          : context.refund!.amount > APPROVAL_THRESHOLD
            ? { target: "awaitingApproval" }
            : { target: "refunding" },
    },
    awaitingApproval: {
      meta: {
        interaction: {
          label: "Refund ${refund.amount} on {refund.orderId}?",
          events: {
            APPROVE: { label: "Refund", style: "primary" },
            REJECT: { label: "Decline", style: "danger" },
          },
        },
      },
      on: {
        APPROVE: { target: "refunding" },
        REJECT: { target: "declined" },
      },
    },
    refunding: {
      // Taken before the invoke starts, so an over-total refund never runs.
      always: ({ context }) =>
        context.refund === null ||
        context.refund.amount > context.orders[context.refund.orderId]!.total
          ? { target: "refundOverTotal" }
          : undefined,
      invoke: {
        src: "issueRefund",
        input: ({ context }) => context.refund!,
        onDone: { target: "refunded" },
      },
    },
    answered: {
      type: "final",
      output: ({ context }) => ({ outcome: "answered" as const, reply: context.reply }),
    },
    refunded: {
      type: "final",
      output: ({ context }) => ({
        outcome: "refunded" as const,
        reply: `Refunded $${context.refund!.amount} on ${context.refund!.orderId}.`,
      }),
    },
    declined: {
      type: "final",
      output: () => ({ outcome: "declined" as const, reply: "Refund declined." }),
    },
    stepLimit: {
      type: "final",
      output: () => ({ outcome: "step-limit" as const, reply: "" }),
    },
    refundOverTotal: {
      type: "final",
      description: "SENTINEL: a refund above the order total reached the refund tool.",
      output: () => ({ outcome: "declined" as const, reply: "Refund declined." }),
    },
  },
});

/** The loop's `generateText` call, unchanged, as the `assist` executor. */
function createExecutors(model: LanguageModel, tools: SupportTools): AgentRequestExecutors {
  const { execute: _execute, ...refundSpec } = tools.issueRefund;
  return {
    generateText: async (request) => {
      const { text, toolCalls, toolResults, response } = await generateText({
        model,
        system: request.system,
        messages: request.messages as ModelMessage[],
        tools: { lookupOrder: tools.lookupOrder, issueRefund: refundSpec },
        stopWhen: stepCountIs(1),
      });
      const refundCall = toolCalls.find((call) => call.toolName === "issueRefund");
      const lookups = toolResults.flatMap((result) => {
        const order = orderSchema.safeParse(result.output);
        return result.toolName === "lookupOrder" && order.success ? [order.data] : [];
      });
      return {
        result: {
          text,
          calledTools: toolCalls.length > 0,
          // JSON-safe for the snapshot: drops the SDK's `undefined` fields.
          messages: JSON.parse(JSON.stringify(response.messages)) as ModelMessage[],
          lookups,
          refund: refundCall ? refundSchema.parse(refundCall.input) : null,
        },
      };
    },
  };
}

/** `before.ts`'s `runRefundLoop`, with the loop replaced by `runAgent`. */
export async function runRefundMachine({
  ticket,
  model,
  tools,
  approve,
}: RefundRequest): Promise<RefundResult> {
  const result = await runAgent(refundLoopMachine, {
    input: { ticket },
    executors: createExecutors(model, tools),
    actors: {
      issueRefund: createAsyncLogic<{ refundId: string }, Refund>({
        // The same tool function the loop called after approval.
        run: async ({ input }) =>
          (await tools.issueRefund.execute!(input, {
            toolCallId: "machine",
            messages: [],
            context: {},
          })) as { refundId: string },
      }),
    },
    onIdle: async (snapshot) =>
      (await approve(snapshot.context.refund!))
        ? { type: "APPROVE" as const }
        : { type: "REJECT" as const },
  });
  if (result.status === "done") return result.output;
  throw result.status === "error" ? result.error : new Error(`Run settled ${result.status}`);
}

// --- Scenarios and the stand-in model ---------------------------------------

export const ORDERS: Order[] = [
  { orderId: "A-100", total: 20 },
  { orderId: "A-200", total: 240 },
];

export interface Scenario {
  /** Reserved by `compareRuns`: the row's name. */
  id: string;
  ticket: string;
  orderId: string;
  /** The refund the stand-in model asks for, or `null` to answer in text. */
  refundAmount: number | null;
  /** What the person answers when asked to approve. */
  approves: boolean;
}

export const SCENARIOS: Scenario[] = [
  {
    id: "small-refund",
    ticket: "Mug A-100 arrived chipped. Refund the $20, please.",
    orderId: "A-100",
    refundAmount: 20,
    approves: true,
  },
  {
    id: "large-refund",
    ticket: "Desk A-200 came with a cracked leg. I want the full $240 back.",
    orderId: "A-200",
    refundAmount: 240,
    approves: true,
  },
  {
    id: "declined-refund",
    ticket: "Desk A-200 is wobbly. Refund all $240.",
    orderId: "A-200",
    refundAmount: 240,
    approves: false,
  },
  {
    id: "order-status",
    ticket: "Where is my order A-100?",
    orderId: "A-100",
    refundAmount: null,
    approves: true,
  },
];

const usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

/**
 * A deterministic stand-in for the provider: look the order up, then refund
 * or answer. A fresh instance per run, since it counts its calls.
 */
export function createStandInModel(scenario: Scenario): MockLanguageModelV3 {
  let call = 0;
  const toolCall = (toolName: string, input: unknown) => ({
    content: [
      {
        type: "tool-call" as const,
        toolCallId: `call-${call}`,
        toolName,
        input: JSON.stringify(input),
      },
    ],
    finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
    usage,
    warnings: [],
  });
  return new MockLanguageModelV3({
    doGenerate: async () => {
      call++;
      if (call === 1) return toolCall("lookupOrder", { orderId: scenario.orderId });
      if (scenario.refundAmount !== null) {
        return toolCall("issueRefund", {
          orderId: scenario.orderId,
          amount: scenario.refundAmount,
        });
      }
      return {
        content: [{ type: "text" as const, text: `Order ${scenario.orderId} ships Monday.` }],
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage,
        warnings: [],
      };
    },
  });
}

type Runner = (request: RefundRequest) => Promise<RefundResult>;

/** Runs the loop on the stand-in model and records its effects: the golden run. */
export async function recordLoop(scenario: Scenario): Promise<Recording> {
  const recorder = createRecorder();
  const result = await runRefundLoop({
    ticket: scenario.ticket,
    model: recorder.model(createStandInModel(scenario)),
    tools: recorder.tools(createTools(createWorld(ORDERS))),
    approve: async () => scenario.approves,
  });
  recorder.output(result);
  // JSON-safe: a real project writes this to a fixture file.
  return JSON.parse(JSON.stringify(recorder.recording)) as Recording;
}

/** Runs the machine against a recording: no model runs, no tool runs. */
export async function replayMachine(
  scenario: Scenario,
  recording: Recording,
): Promise<EquivalenceReport> {
  const replay = createRecorder({ replay: recording });
  const result = await runRefundMachine({
    ticket: scenario.ticket,
    // Never called in replay.
    model: replay.model(new MockLanguageModelV3()),
    tools: replay.tools(createTools(createWorld(ORDERS))),
    approve: async () => scenario.approves,
  });
  replay.output(result);
  return compareRecordings(recording, replay.recording);
}

/** One live run on a fresh world, reduced to what parity compares. */
const parityRun =
  (runner: Runner) =>
  async (scenario: Scenario): Promise<ParityRun> => {
    const world = createWorld(ORDERS);
    const result = await runner({
      ticket: scenario.ticket,
      model: createStandInModel(scenario),
      tools: createTools(world),
      approve: async (refund) => {
        world.approvals.push(refund);
        return scenario.approves;
      },
    });
    return {
      outcome: result.outcome,
      // Every write the world records, not only the refunds.
      effects: { refunds: world.refunds, approvals: world.approvals },
      violations: world.refunds
        .filter((refund) => !withinOrderTotal(world.orders, refund))
        .map((refund) => `refund over total on ${refund.orderId}`),
    };
  };

export function compareLoopAndMachine(): Promise<ParityReport<Scenario>> {
  return compareRuns({
    scenarios: SCENARIOS,
    baseline: parityRun(runRefundLoop),
    candidate: parityRun(runRefundMachine),
  });
}

/** Records every scenario, replays the machine against it, and compares outcomes. */
export async function runRetrofitParityExample() {
  const equivalence: Record<string, EquivalenceReport> = {};
  for (const scenario of SCENARIOS) {
    equivalence[scenario.id] = await replayMachine(scenario, await recordLoop(scenario));
  }
  return { equivalence, parity: await compareLoopAndMachine() };
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  void runRetrofitParityExample().then(({ equivalence, parity }) => {
    for (const [id, report] of Object.entries(equivalence)) {
      console.log(`${id}: ${report.equivalent ? "equivalent" : report.divergence?.message}`);
    }
    for (const row of parity.scenarios) console.log(`${row.id}: ${row.label} ${row.reason}`);
  });
}
