/**
 * Verify in place: check the refund agent in `before.ts` against its model in
 * `model.ts`, without changing the code.
 *
 *   1. Record each run of the code with `createRecorder`, wrapping the
 *      functions in its `effects` object. The code is not edited.
 *   2. Map each recorded call, and the return value, to an observation
 *      (`toObservations`).
 *   3. Check each run against the model with `checkConformance`, including
 *      the approval each person gave and the outcome the code returned.
 *   4. Measure which parts of the model no run reached with `traceCoverage`.
 *
 * The model's rules are proved separately with `canReach` (see index.test.ts).
 * A conforming run shows the code behaved as the model allows on that run.
 *
 * Run: npx tsx examples/verify-in-place/index.ts
 */
import { traceCoverage } from "@statelyai/agent/evals";
import {
  checkConformance,
  createRecorder,
  type ConformanceReport,
  type Recording,
} from "@statelyai/agent/testing";
import { handleRefundRequest, type Decision, type Order, type RefundEffects } from "./before.js";
import { refundModel } from "./model.js";

// --- Scenarios: scripted stand-ins for the model and the person. ---

export interface Scenario {
  id: string;
  order: Order;
  decisions: Decision[];
  approvals?: boolean[];
  repeatCustomer?: boolean;
}

export const SCENARIOS: Scenario[] = [
  {
    id: "small refund",
    order: { orderId: "A-1", total: 60 },
    decisions: [{ type: "refund", amount: 40 }],
  },
  {
    id: "large refund, approved",
    order: { orderId: "A-2", total: 500 },
    decisions: [{ type: "refund", amount: 250 }],
    approvals: [true],
  },
  {
    id: "large refund, rejected",
    order: { orderId: "A-3", total: 500 },
    decisions: [{ type: "refund", amount: 250 }],
    approvals: [false],
  },
  {
    id: "over the order total",
    order: { orderId: "A-4", total: 30 },
    decisions: [{ type: "refund", amount: 80 }],
  },
  {
    id: "investigate, then reply",
    order: { orderId: "A-5", total: 90 },
    decisions: [{ type: "investigate" }, { type: "reply", message: "Your refund is on its way." }],
  },
  {
    id: "too many decisions",
    order: { orderId: "A-6", total: 90 },
    decisions: [{ type: "investigate" }, { type: "investigate" }, { type: "investigate" }],
  },
  {
    id: "repeat customer, mid-size refund",
    order: { orderId: "A-7", total: 400 },
    decisions: [{ type: "refund", amount: 150 }],
    approvals: [true],
    repeatCustomer: true,
  },
];

export type RefundLoop = (
  fx: RefundEffects,
  request: { orderId: string; message: string; repeatCustomer?: boolean },
) => Promise<unknown>;

// --- 1. Record a run of the code. ---

export async function recordRun(
  scenario: Scenario,
  loop: RefundLoop = handleRefundRequest,
): Promise<Recording> {
  const recorder = createRecorder();
  const decisions = [...scenario.decisions];
  const approvals = [...(scenario.approvals ?? [])];
  const fx: RefundEffects = {
    lookupOrder: recorder.fn("lookupOrder", async () => scenario.order),
    decide: recorder.fn("decide", async () => decisions.shift() ?? { type: "investigate" }),
    requestApproval: recorder.fn("requestApproval", async () => approvals.shift() ?? false),
    issueRefund: recorder.fn("issueRefund", async () => {}),
  };
  recorder.output(
    await loop(fx, {
      orderId: scenario.order.orderId,
      message: "Please refund my order",
      repeatCustomer: scenario.repeatCustomer,
    }),
  );
  return recorder.recording;
}

// --- 2. Map recorded calls to observations. ---

export type Observation =
  | { kind: "lookup"; order: Order }
  | { kind: "decision"; decision: Decision }
  | { kind: "approval"; approved: boolean; amount: number }
  | { kind: "refund"; orderId: string; amount: number }
  | { kind: "returned"; outcome: unknown };

export function toObservations(recording: Recording): Observation[] {
  return recording.effects.flatMap((effect): Observation[] => {
    if (effect.kind === "output") return [{ kind: "returned", outcome: effect.value }];
    if (effect.kind !== "call") return [];
    switch (effect.name) {
      case "lookupOrder":
        return [{ kind: "lookup", order: effect.result as Order }];
      case "decide":
        return [{ kind: "decision", decision: effect.result as Decision }];
      case "requestApproval":
        return [
          {
            kind: "approval",
            approved: effect.result as boolean,
            amount: (effect.args as [{ amount: number }])[0].amount,
          },
        ];
      case "issueRefund":
        return [{ kind: "refund", ...(effect.args as [{ orderId: string; amount: number }])[0] }];
      default:
        return [];
    }
  });
}

// --- 3. Check a run against the model. ---

export function checkRun(
  scenario: Scenario,
  recording: Recording,
): Promise<ConformanceReport<Observation>> {
  return checkConformance(refundModel, {
    input: { orderId: scenario.order.orderId },
    observations: toObservations(recording),
    actors: {
      lookupOrder: {
        observes: "lookup",
        output: ({ observation }) =>
          (observation as Extract<Observation, { kind: "lookup" }>).order,
      },
      decide: {
        observes: "decision",
        output: ({ observation }) =>
          (observation as Extract<Observation, { kind: "decision" }>).decision,
      },
      issueRefund: {
        observes: "refund",
        // The refund the code issued must be the one the model would issue.
        matches: ({ input, observation }) => {
          const refund = observation as Extract<Observation, { kind: "refund" }>;
          const expected = input as { orderId: string; amount: number };
          return expected.orderId === refund.orderId && expected.amount === refund.amount;
        },
      },
    },
    events: {
      approval: {
        event: (observation) => ({
          type: (observation as Extract<Observation, { kind: "approval" }>).approved
            ? "APPROVE"
            : "REJECT",
        }),
        // The person approved the amount the model is waiting to refund.
        matches: ({ observation, context }) =>
          (observation as Extract<Observation, { kind: "approval" }>).amount ===
          (context as { amount: number }).amount,
      },
    },
    // The outcome the code returned is the one the model ends with.
    output: {
      observes: "returned",
      matches: ({ output, observation }) =>
        (output as { outcome: string }).outcome ===
        (observation as Extract<Observation, { kind: "returned" }>).outcome,
    },
  });
}

/** Records and checks every scenario, and reports which states no run reached. */
export async function runVerifyInPlaceExample(loop: RefundLoop = handleRefundRequest) {
  const rows = [];
  const traces = [];
  for (const scenario of SCENARIOS) {
    const report = await checkRun(scenario, await recordRun(scenario, loop));
    traces.push(report.trace);
    rows.push({ id: scenario.id, conforms: report.conforms, deviation: report.deviation });
  }
  const coverage = traceCoverage(refundModel, traces);
  return {
    rows,
    unvisitedStates: coverage.unvisitedStates,
    unvisitedHandlers: coverage.unvisitedHandlers,
  };
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  const { rows, unvisitedStates } = await runVerifyInPlaceExample();
  for (const row of rows) {
    console.log(`${row.conforms ? "conforms" : "DEVIATES"}  ${row.id}`);
  }
  console.log(
    "states no run reached:",
    unvisitedStates.length ? unvisitedStates.join(", ") : "none",
  );
}
