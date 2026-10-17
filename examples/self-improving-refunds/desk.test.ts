import { describe, expect, test } from "vitest";
import { createMachine, type AnyMachineSnapshot } from "xstate";
import { type AgentDecisionExecutor, type ChosenEvent } from "@statelyai/agent";
import { createInMemoryEventLogStore } from "@statelyai/agent/log";
import { canReach, lintAgentMachine, type ExplorePathsOptions } from "@statelyai/agent/testing";
import {
  APPROVAL_THRESHOLD,
  ASK_QUESTION,
  MAX_REJECTIONS,
  ORDERS,
  PROPOSALS,
  SCENARIOS,
  runBatch,
  type Order,
  type Scenario,
} from "./contract.js";
import {
  createDeskArm,
  createWorldActors,
  factsOf,
  refundDeskMachine,
  refundDeskSchemas,
  runDeskEpisode,
} from "./desk.js";
import { rightPath } from "./test-doubles.js";

const scenario = (id: string): Scenario => SCENARIOS.find((s) => s.id === id)!;
const inputOf = (s: Scenario) => ({ ticket: s.ticket, customerId: s.customerId });

// ─── The proof: canReach over payloads, tool outputs, errors, and human answers ───
//
// At `deciding` every PROPOSAL forks once per payload in the tables below
// (adversarial, far wider than the closed vocabulary a decider is offered),
// plus GIVE_UP; each tool invoke forks over EVERY output in an adversarial
// table (any order, any owner, refunded or not, missing; identity true or
// false) plus a failure; each human wait forks over its answers. Tool results
// are not tied to the requested id or the claim, so this covers every
// possible world, not only the sample one.
//
// `dedupeBy` explores each guard-relevant projection once: state, identity,
// order, approval, turn, and customer. Every guard and choice reads only those
// fields plus the proposal's own amount, which the monitor reads in the same
// macrostep the guard admitted it (`checkingIssue` is a transient choice
// state). So two snapshots with the same projection have the same futures,
// and `complete: true` makes `reachable: false` a proof for the turn budget.

// Every boundary the guards compare against: zero, the threshold on both
// sides, and sample order totals on both sides.
const AMOUNTS = [0, 1, 40, APPROVAL_THRESHOLD, APPROVAL_THRESHOLD + 0.01, 240, 240.01, 520, 10_000];
const ORDER_IDS = ["ORD-1001", "ORD-1004", "ORD-9999"];

// One order per guard-relevant class: under the threshold, over it, refunded.
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

const payloads = () => ({
  LOOKUP_ORDER: ORDER_IDS.map((orderId) => ({ orderId })),
  ASK_CUSTOMER: [{ question: ASK_QUESTION }],
  REQUEST_APPROVAL: AMOUNTS.map((amount) => ({ amount })),
  ISSUE_REFUND: AMOUNTS.map((amount) => ({ amount })),
  ESCALATE: [{ reason: "explore" }],
  CLOSE: [{ reason: "explore" }],
  GIVE_UP: [{ reason: "explore" }],
  IDENTITY_CLAIM: [{ claim: "ada@example.com, order placed 2026-09-02" }, { claim: "nobody" }],
  CUSTOMER_REPLY: [{ reply: "It was ORD-1005" }, { reply: "no idea" }],
  REJECT: [{ reason: "Not eligible" }],
});

const failure = new Error("tool failed");
const projection = (snapshot: AnyMachineSnapshot) => {
  const c = snapshot.context as Record<string, unknown>;
  return JSON.stringify([
    snapshot.value,
    c.identityVerified,
    c.order,
    c.approved,
    c.turn,
    c.customerId,
  ]);
};

const proofOptions = (input: { ticket: string; customerId: string }): ExplorePathsOptions => ({
  input,
  payloads,
  outputs: {
    verifyIdentity: [true, false],
    lookupOrder: ORDER_OUTCOMES,
    issueRefund: [{ issued: true }],
  },
  errors: { verifyIdentity: failure, lookupOrder: failure, issueRefund: failure },
  dedupeBy: projection,
  // Each turn spends at most 3 branch points (proposal, human answer, tool result).
  maxDepth: 40,
  maxPaths: 1_000_000,
});

/** The searches take a few seconds each; well under this unless the host is swamped. */
const SEARCH_TIMEOUT_MS = 60_000;

/** A copy of the desk whose ISSUE_REFUND guard forgets the approval and owner checks. */
const brokenDesk = () => {
  const config = refundDeskMachine.config as Record<string, any>;
  return createMachine({
    ...config,
    schemas: refundDeskSchemas,
    actors: createWorldActors({} as never),
    states: {
      ...config.states,
      deciding: {
        ...config.states.deciding,
        on: {
          ...config.states.deciding.on,
          ISSUE_REFUND: ({ context, event }: { context: any; event: any }) =>
            context.identityVerified &&
            context.order &&
            !context.order.refunded &&
            event.amount > 0 &&
            event.amount <= context.order.total
              ? {
                  target: "checkingIssue",
                  context: { pendingProposal: { type: "ISSUE_REFUND", amount: event.amount } },
                }
              : undefined,
        },
      },
    },
  } as never);
};

const formatPath = (path: ChosenEvent[]) =>
  path
    .map((event) => {
      if (event.type.startsWith("xstate.done.actor")) {
        const output = (event as { output?: unknown }).output as Order | null;
        return output && typeof output === "object" && "id" in output
          ? `done(${output.id} of ${output.customerId}${output.refunded ? ", refunded" : ""})`
          : `done(${JSON.stringify(output)})`;
      }
      const e = event as { amount?: number; orderId?: string };
      return e.amount !== undefined
        ? `${event.type} $${e.amount}`
        : e.orderId
          ? `${event.type} ${e.orderId}`
          : event.type;
    })
    .join(" → ");

// ─── Scripted deciders (plain functions as executors; rightPath is in test-doubles.ts) ───

/** Always tries to pay out the order total, offered or not. */
const sloppy: AgentDecisionExecutor = async (request) => ({
  event: { type: "ISSUE_REFUND", amount: factsOf(request).order?.total ?? 100 },
});

describe("refund desk (the environment)", () => {
  test("is a plain machine that lints clean", () => {
    expect(lintAgentMachine(refundDeskMachine)).toEqual([]);
    expect(refundDeskMachine.root.description).toMatch(/^Resolve each refund ticket correctly/);
    for (const type of PROPOSALS) {
      expect(refundDeskSchemas.events[type].description, type).toBeTruthy();
    }
  });

  test.each(["C-1", "C-2", "C-3"])(
    "canReach proof: no payload, tool result, or answer reaches illegallyIssued (customer %s)",
    async (customerId) => {
      const started = performance.now();
      const input = { ticket: "Refund ORD-1001 please", customerId };
      const violation = await canReach(refundDeskMachine, "illegallyIssued", proofOptions(input));
      console.log(
        `proof ${customerId}: reachable=${violation.reachable} complete=${violation.complete} ` +
          `(${Math.round(performance.now() - started)}ms)`,
      );
      expect(violation).toMatchObject({ reachable: false, complete: true });

      // The search is real: the same options reach the payout and every terminal.
      for (const state of ["approving", "issued", "closed", "escalated"]) {
        const reached = await canReach(refundDeskMachine, state, proofOptions(input));
        expect(reached.reachable, `${customerId} reaches ${state}`).toBe(true);
      }
    },
    SEARCH_TIMEOUT_MS,
  );

  test(
    "a deliberately broken guard copy IS caught, with a witness",
    async () => {
      const leak = await canReach(
        brokenDesk(),
        "illegallyIssued",
        proofOptions({ ticket: "Refund ORD-1004 please", customerId: "C-2" }),
      );
      expect(leak.reachable).toBe(true);
      console.log(`broken-guard witness: ${formatPath(leak.witness!)}`);
      expect(leak.witness!.map((event) => event.type)).toContain("ISSUE_REFUND");
    },
    SEARCH_TIMEOUT_MS,
  );

  test(
    "issued IS reachable for small-clean, with a witness",
    async () => {
      const result = await canReach(
        refundDeskMachine,
        "issued",
        proofOptions(inputOf(scenario("small-clean"))),
      );
      expect(result.reachable).toBe(true);
      console.log(`small-clean issued witness: ${formatPath(result.witness!)}`);
      const types = result.witness!.map((event) => event.type);
      expect(types).toContain("VERIFY_IDENTITY");
      expect(types).toContain("ISSUE_REFUND");
    },
    SEARCH_TIMEOUT_MS,
  );
});

describe("the decider at the boundary", () => {
  test("a scripted right-path decider solves all 8 scenarios, journaled to the store", async () => {
    let calls = 0;
    const store = createInMemoryEventLogStore();
    const batch = await runBatch(
      createDeskArm({
        label: "scripted",
        decide: (request, info) => {
          calls++;
          return rightPath(request, info);
        },
        store,
        counters: () => ({ modelCalls: calls, judgeCalls: 0 }),
      }),
    );
    for (const episode of batch.episodes) {
      expect(episode.correct, `${episode.scenarioId}: ${episode.trail.join(" | ")}`).toBe(true);
      expect(episode.violations).toEqual([]);
      // The trace is the thread: an init entry plus every input the desk consumed.
      const entries = await store.read(episode.threadId!);
      expect(entries[0]?.event.type).toBe("@agent.init");
      expect(entries.length).toBeGreaterThan(2);
    }
    expect(batch.accuracy).toBe(1);
    expect(batch.violations).toBe(0);
    expect(batch.rejections).toBe(1); // identity-fails: the failed identity check
    expect(batch.modelCalls).toBe(calls);

    const largeApproved = batch.episodes.find((e) => e.scenarioId === "large-approved")!;
    expect(largeApproved.threadId).toBe("scripted/large-approved");
    expect(largeApproved.trail).toEqual([
      "turn 1: LOOKUP_ORDER ORD-1002",
      "turn 1: ORD-1002 found ($240, C-1)",
      "turn 2: VERIFY_IDENTITY",
      "turn 2: customer answered the identity check",
      "turn 2: identity verified",
      "turn 3: REQUEST_APPROVAL $240",
      "turn 3: approved",
      "turn 4: ISSUE_REFUND $240",
      "turn 4: refund issued",
    ]);
  });

  test("a sloppy decider never causes a violation, and its misses are counted", async () => {
    for (const s of SCENARIOS) {
      const episode = await runDeskEpisode(s, { decide: sloppy });
      expect(episode.violations, s.id).toEqual([]);
      expect(episode.outcome, s.id).toBe("escalate");
      expect(episode.rejections, s.id).toBe(MAX_REJECTIONS);
      expect(episode.trail[0], s.id).toBe(
        `turn 1: GIVE_UP (${MAX_REJECTIONS} choices matched no legal option)`,
      );
    }
  });

  test("the decider is only ever offered legal options", async () => {
    const seen: string[][] = [];
    await runDeskEpisode(scenario("large-approved"), {
      decide: async (request, info) => {
        seen.push((request.options ?? []).map(({ event }) => event.type));
        return rightPath(request, info);
      },
    });
    // Turn 1: no order loaded, identity unverified, so no payout and no approval request.
    expect(seen[0]).not.toContain("ISSUE_REFUND");
    expect(seen[0]).not.toContain("REQUEST_APPROVAL");
    // Turn 4: approved, so the payout is legal and another approval is not.
    expect(seen[3]).toContain("ISSUE_REFUND");
    expect(seen[3]).not.toContain("REQUEST_APPROVAL");
  });
});
