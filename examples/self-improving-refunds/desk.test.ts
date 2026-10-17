import { describe, expect, test } from "vitest";
import { initialTransition, transition, type AnyMachineSnapshot } from "xstate";
import {
  AgentDecisionExhaustedError,
  type AgentDecisionExecutor,
  type ChosenEvent,
} from "@statelyai/agent";
import {
  assertAgentMachine,
  canReach,
  explorePaths,
  lintAgentMachine,
  simulateAgent,
} from "@statelyai/agent/testing";
import {
  APPROVAL_THRESHOLD,
  MAX_REJECTIONS,
  ORDERS,
  PROPOSALS,
  SCENARIOS,
  runBatch,
  type Order,
  type Scenario,
} from "./contract.js";
import { createDeskArm, factsOf, refundDeskMachine, runDeskEpisode } from "./desk.js";

const scenario = (id: string): Scenario => SCENARIOS.find((s) => s.id === id)!;
const inputOf = (s: Scenario) => ({ ticket: s.ticket, customerId: s.customerId });

// ─── Exhaustive search over the pure transition function ───
//
// `explorePaths`/`canReach` deliver every proposal and external event by TYPE
// only (`{ type: 'ISSUE_REFUND' }`, no amount), so every payload-guarded
// proposal (ISSUE_REFUND, REQUEST_APPROVAL) is pruned there and the payout
// branch is never explored. This search closes that gap: breadth-first over
// xstate's pure `transition`, branching at
//   - `deciding`: every PROPOSAL × every payload in the tables below, taken
//     only when `snapshot.can(event)` (exactly the runtime's guard check), plus
//     the decider-exhausted error;
//   - each tool invoke: EVERY output in an adversarial table (any order,
//     any customer, refunded or not, missing; identity true or false), plus an
//     invoke error. Results are not tied to the requested id or the claim, so
//     this covers every possible world, not just the sample one;
//   - each idle state: every external event it accepts.
// Visited states are deduplicated on the guard-relevant projection of the
// context (state, identityVerified, order, approved, turn, customerId). Every
// guard and choice in the desk reads only those fields plus the proposal's
// own amount, which the monitor reads inside the same macrostep that the
// guard admitted it (`checkingIssue` is a transient choice state). So two
// snapshots with the same projection have the same futures: the dedup is
// sound, and the search is complete for the turn budget (MAX_TURNS bounds
// every path).

// Every boundary the guards compare against: zero, the threshold on both
// sides, and each sample order's total on both sides. Anything between two
// boundaries takes the same branch as one of them.
const AMOUNTS = [0, 1, 40, APPROVAL_THRESHOLD, APPROVAL_THRESHOLD + 0.01, 240, 240.01, 520, 10_000];
const ORDER_IDS = ["ORD-1001", "ORD-1004", "ORD-9999"];

const PROPOSAL_VARIANTS: ChosenEvent[] = PROPOSALS.flatMap((type): ChosenEvent[] => {
  switch (type) {
    case "VERIFY_IDENTITY":
      return [{ type }];
    case "LOOKUP_ORDER":
      return ORDER_IDS.map((orderId) => ({ type, orderId }));
    case "ASK_CUSTOMER":
      return [{ type, question: "Which order?" }];
    case "REQUEST_APPROVAL":
    case "ISSUE_REFUND":
      return AMOUNTS.map((amount) => ({ type, amount }));
    case "ESCALATE":
    case "CLOSE":
      return [{ type, reason: "explore" }];
  }
});

// One order per guard-relevant class: under the threshold, over it, and
// already refunded. The other sample orders fall into the same classes.
const SEARCH_ORDERS = ORDERS.filter((order) =>
  ["ORD-1001", "ORD-1003", "ORD-1004"].includes(order.id),
);

const ORDER_OUTCOMES: (Order | null)[] = [
  null,
  ...SEARCH_ORDERS.flatMap((order) => [order, { ...order, refunded: !order.refunded }]),
  // Same id, every other owner: the wrong-customer case for each input.
  ...SEARCH_ORDERS.flatMap((order) =>
    ["C-1", "C-2", "C-3"]
      .filter((customerId) => customerId !== order.customerId)
      .map((customerId) => ({ ...order, customerId })),
  ),
];

const INVOKE_OUTCOMES: Record<string, unknown[]> = {
  verifyIdentity: [true, false],
  lookupOrder: ORDER_OUTCOMES,
  issueRefund: [{ issued: true }],
};

const EXTERNAL_EVENTS: Record<string, ChosenEvent[]> = {
  askingIdentity: [
    { type: "IDENTITY_CLAIM", claim: "ada@example.com, order placed 2026-09-02" },
    { type: "IDENTITY_CLAIM", claim: "nobody" },
  ],
  askingCustomer: [
    { type: "CUSTOMER_REPLY", reply: "It was ORD-1005" },
    { type: "CUSTOMER_REPLY", reply: "no idea" },
  ],
  approving: [{ type: "APPROVE" }, { type: "REJECT", reason: "Not eligible" }],
};

/** The searches take a few seconds each; well under this unless the host is swamped. */
const SEARCH_TIMEOUT_MS = 60_000;

type Snap = AnyMachineSnapshot;

function projection(snapshot: Snap): string {
  const c = snapshot.context as {
    identityVerified: boolean;
    order: Order | null;
    approved: boolean;
    turn: number;
    customerId: string;
  };
  return JSON.stringify([
    snapshot.value,
    c.identityVerified,
    c.order,
    c.approved,
    c.turn,
    c.customerId,
  ]);
}

function invokeEvent(snapshot: Snap, kind: "done" | "error", payload: unknown) {
  const [id, child] = Object.entries(
    snapshot.children as Record<string, { sessionId?: string }>,
  )[0]!;
  return {
    type: kind === "done" ? "xstate.done.actor" : "xstate.error.actor",
    actorId: id,
    sessionId: child.sessionId,
    ...(kind === "done" ? { output: payload } : { error: payload }),
  };
}

function successors(snapshot: Snap): { event: ChosenEvent; next: Snap }[] {
  const state = String(snapshot.value);
  const step = (event: ChosenEvent) => ({
    event,
    next: transition(refundDeskMachine, snapshot as never, event as never)[0] as Snap,
  });
  if (state === "deciding") {
    return [
      ...PROPOSAL_VARIANTS.filter((event) => snapshot.can(event as never)).map(step),
      step(invokeEvent(snapshot, "error", new AgentDecisionExhaustedError([])) as never),
    ];
  }
  if (state in EXTERNAL_EVENTS) return EXTERNAL_EVENTS[state]!.map(step);
  const src: Record<string, string> = {
    verifyingIdentity: "verifyIdentity",
    lookingUp: "lookupOrder",
    issuing: "issueRefund",
  };
  if (state in src) {
    return [
      ...INVOKE_OUTCOMES[src[state]!]!.map((output) =>
        step(invokeEvent(snapshot, "done", output) as never),
      ),
      step(invokeEvent(snapshot, "error", new Error("tool failed")) as never),
    ];
  }
  return [];
}

/** BFS from `input`; returns every reached state value and a witness path per state. */
function exhaustiveSearch(input: { ticket: string; customerId: string }) {
  const [initial] = initialTransition(refundDeskMachine, input as never);
  const witnesses = new Map<string, ChosenEvent[]>([[String(initial.value), []]]);
  const seen = new Set([projection(initial as Snap)]);
  const queue: { snapshot: Snap; path: ChosenEvent[] }[] = [
    { snapshot: initial as Snap, path: [] },
  ];
  let expanded = 0;
  let pruned = 0;
  for (let head = 0; head < queue.length; head++) {
    const { snapshot, path } = queue[head]!;
    expanded++;
    if (snapshot.status === "done") continue;
    if (String(snapshot.value) === "deciding") {
      pruned += PROPOSAL_VARIANTS.filter((event) => !snapshot.can(event as never)).length;
    }
    for (const { event, next } of successors(snapshot)) {
      const key = projection(next);
      if (seen.has(key)) continue;
      seen.add(key);
      const nextPath = [...path, event];
      if (!witnesses.has(String(next.value))) witnesses.set(String(next.value), nextPath);
      queue.push({ snapshot: next, path: nextPath });
    }
  }
  return { witnesses, expanded, pruned };
}

const formatPath = (path: ChosenEvent[]) =>
  path
    .map((event) => {
      if (event.type.startsWith("xstate.done.actor")) {
        const output = (event as { output?: unknown }).output;
        const id = (output as { id?: string } | null)?.id;
        return `done(${id ?? JSON.stringify(output)})`;
      }
      const e = event as { amount?: number; orderId?: string };
      return e.amount !== undefined
        ? `${event.type} $${e.amount}`
        : e.orderId
          ? `${event.type} ${e.orderId}`
          : event.type;
    })
    .join(" → ");

// ─── Scripted deciders (plain functions as executors) ───

/** The right path for every sample scenario, read off the facts alone. */
const rightPath: AgentDecisionExecutor = async (request) => {
  const facts = factsOf(request);
  const choose = (event: ChosenEvent) => ({ event });
  if (!facts.order) {
    if (facts.rejections.some((r) => r.proposal === "LOOKUP_ORDER")) {
      return choose({ type: "ESCALATE", reason: "order not found" });
    }
    const orderId = facts.orderIdCandidates[0];
    if (orderId) return choose({ type: "LOOKUP_ORDER", orderId });
    if (facts.customerReplies.length === 0) {
      return choose({ type: "ASK_CUSTOMER", question: "Which order is this about?" });
    }
    return choose({ type: "ESCALATE", reason: "no order id" });
  }
  if (facts.order.customerId !== facts.customerId) {
    return choose({ type: "ESCALATE", reason: "order belongs to another customer" });
  }
  if (facts.order.refunded) return choose({ type: "CLOSE", reason: "already refunded" });
  if (!/refund|back|broken|never shipped/i.test(facts.ticket)) {
    return choose({ type: "CLOSE", reason: "not a refund request" });
  }
  if (!facts.identityVerified) {
    return facts.rejections.some((r) => r.proposal === "VERIFY_IDENTITY")
      ? choose({ type: "ESCALATE", reason: "identity could not be verified" })
      : choose({ type: "VERIFY_IDENTITY" });
  }
  const amount = facts.order.total;
  if (amount > facts.approvalThreshold && !facts.approved) {
    return choose({ type: "REQUEST_APPROVAL", amount });
  }
  return choose({ type: "ISSUE_REFUND", amount });
};

/** Always tries to pay out the order total; escalates once it sees a rejection. */
const sloppy: AgentDecisionExecutor = async (request) => {
  const facts = factsOf(request);
  return request.attempts.length > 0
    ? { event: { type: "ESCALATE", reason: "my refund was rejected" } }
    : { event: { type: "ISSUE_REFUND", amount: facts.order?.total ?? 100 } };
};

describe("refund desk", () => {
  test("lints clean", () => {
    // No warnings either: every invoke has an onError and agent.decide has handlers.
    expect(lintAgentMachine(refundDeskMachine)).toEqual([]);
    assertAgentMachine(refundDeskMachine, { warnings: true });
  });

  test("canReach: illegallyIssued unreachable under type-only exploration", async () => {
    // What this covers: every proposal TYPE and every idle answer, with each
    // tool returning a fixed output, to the depth below. What it does not:
    // payloads. explorePaths applies `{ type }` alone, so ISSUE_REFUND and
    // REQUEST_APPROVAL (whose guards read `amount`) are always pruned and the
    // payout branch is never entered. The exhaustive search below is the proof.
    const cases: { name: string; input: { ticket: string; customerId: string }; order: Order }[] = [
      { name: "small order", input: inputOf(scenario("small-clean")), order: ORDERS[0]! },
      { name: "large order", input: inputOf(scenario("large-rejected")), order: ORDERS[3]! },
      { name: "refunded order", input: inputOf(scenario("already-refunded")), order: ORDERS[2]! },
      { name: "wrong customer", input: inputOf(scenario("wrong-customer")), order: ORDERS[1]! },
    ];
    for (const { name, input, order } of cases) {
      const options = {
        input,
        invokes: { verifyIdentity: true, lookupOrder: order, issueRefund: { issued: true } },
        maxDepth: 6,
        maxPaths: 10_000,
      };
      const violation = await canReach(refundDeskMachine, "illegallyIssued", options);
      expect(violation.reachable, name).toBe(false);
      const report = await explorePaths(refundDeskMachine, options);
      expect(report.hitPathCap, name).toBe(false);
      expect(report.prunedByGuard, name).toBeGreaterThan(0);
      expect(report.reachedStates, name).not.toContain("issuing");
    }
  });

  test.each(["C-1", "C-2", "C-3"])(
    "exhaustive search: no proposal sequence reaches illegallyIssued (customer %s)",
    (customerId) => {
      const { witnesses, expanded, pruned } = exhaustiveSearch({
        ticket: "Refund ORD-1001 please",
        customerId,
      });
      // The search is real: it reaches the payout, the approval gate, and every
      // terminal, and the guards reject a great many proposals on the way.
      for (const state of ["approving", "issuing", "issued", "closed", "escalated"]) {
        expect(witnesses.has(state), `${customerId} reaches ${state}`).toBe(true);
      }
      expect(expanded).toBeGreaterThan(1_000);
      expect(pruned).toBeGreaterThan(1_000);
      // The claim.
      expect(witnesses.get("illegallyIssued")).toBeUndefined();
    },
    SEARCH_TIMEOUT_MS,
  );

  test(
    "issued IS reachable for small-clean, with a witness",
    async () => {
      const { witnesses } = exhaustiveSearch(inputOf(scenario("small-clean")));
      const witness = witnesses.get("issued");
      expect(witness).toBeDefined();
      console.log(`small-clean issued witness: ${formatPath(witness!)}`);
      // Shortest route: verify, look up, pay; an over-threshold payout needs APPROVE.
      expect(witness!.map((event) => event.type)).toContain("ISSUE_REFUND");
      expect(witness!.map((event) => event.type)).toContain("VERIFY_IDENTITY");

      // Under type-only exploration the payout is pruned, so canReach says no.
      const typeOnly = await canReach(refundDeskMachine, "issued", {
        input: inputOf(scenario("small-clean")),
        invokes: { verifyIdentity: true, lookupOrder: ORDERS[0], issueRefund: { issued: true } },
        maxDepth: 6,
        maxPaths: 10_000,
      });
      expect(typeOnly.reachable).toBe(false);
    },
    SEARCH_TIMEOUT_MS,
  );

  test("simulateAgent: an insistent $520 ISSUE_REFUND exhausts into escalated", async () => {
    const s = scenario("large-rejected");
    const result = await simulateAgent(refundDeskMachine, {
      input: inputOf(s),
      script: { decisions: { "agent.decide": [{ type: "ISSUE_REFUND", amount: 520 }] } },
    });
    expect(result.status).toBe("done");
    expect(result.snapshot.value).toBe("escalated");
    expect(result.snapshot.output).toMatchObject({
      outcome: "escalate",
      rejections: MAX_REJECTIONS,
    });
    expect(result.snapshot.context.stopReason).toBe("decider exhausted");
    expect(result.snapshot.context.rejections[0]).toEqual({
      proposal: "ISSUE_REFUND",
      reason: "identity not verified",
    });

    // The same decider live against the world: nothing pays out.
    const live = await runDeskEpisode(s, {
      decide: async () => ({ event: { type: "ISSUE_REFUND", amount: 520 } }),
    });
    expect(live.outcome).toBe("escalate");
    expect(live.violations).toEqual([]);
    expect(live.rejections).toBe(MAX_REJECTIONS);
  });

  test("a scripted right-path decider solves all 8 scenarios with no violations", async () => {
    let calls = 0;
    const counted: AgentDecisionExecutor = (request, info) => {
      calls++;
      return rightPath(request, info);
    };
    const batch = await runBatch(
      createDeskArm({
        label: "scripted",
        decide: counted,
        counters: () => ({ modelCalls: calls, judgeCalls: 0 }),
      }),
    );
    for (const episode of batch.episodes) {
      expect(episode.correct, `${episode.scenarioId}: ${episode.trail.join(" | ")}`).toBe(true);
      expect(episode.violations).toEqual([]);
    }
    expect(batch.accuracy).toBe(1);
    expect(batch.violations).toBe(0);
    expect(batch.rejections).toBe(1); // identity-fails: the failed identity check
    expect(batch.modelCalls).toBe(calls);

    const largeApproved = batch.episodes.find((e) => e.scenarioId === "large-approved")!;
    expect(largeApproved.trail).toEqual([
      "turn 1: LOOKUP_ORDER ORD-1002",
      "turn 1: ORD-1002 found ($240, C-1)",
      "turn 2: VERIFY_IDENTITY",
      "turn 2: identity verified",
      "turn 3: REQUEST_APPROVAL $240",
      "turn 3: approved $240",
      "turn 4: ISSUE_REFUND $240",
      "turn 4: refund issued",
    ]);
  });

  test("a sloppy decider never causes a violation, and its rejections are counted", async () => {
    for (const s of SCENARIOS) {
      const episode = await runDeskEpisode(s, { decide: sloppy });
      expect(episode.violations, s.id).toEqual([]);
      expect(episode.outcome, s.id).toBe("escalate");
      expect(episode.rejections, s.id).toBeGreaterThan(0);
      expect(episode.trail[0], s.id).toMatch(/^turn 1: ISSUE_REFUND \$\d+ rejected: /);
    }
  });
});
