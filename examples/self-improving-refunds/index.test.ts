/**
 * Integration over the REAL desk: the playbooks, one improvement round, and
 * the demo's idle contract, all through `refundDeskMachine` and its guards.
 */
import { describe, expect, test } from "vitest";
import {
  createAgentRuntime,
  eventFromInteraction,
  getInteraction,
  runToQuiescence,
} from "@statelyai/agent";
import { createMockModelExecutors } from "../mock-model.js";
import { CUSTOMERS, runSplits } from "./contract.js";
import {
  HELD_OUT_SCENARIOS,
  SCENARIOS,
  createDeskArm,
  createPlaybookDecide,
  createWorld,
  createWorldActors,
  loadPlaybook,
  objective,
  refundDeskMachine,
  runSelfImprovingRefundsExample,
} from "./index.js";
import type { PlaybookDecide } from "./playbook.js";
import { eagerChoice, jevJudge } from "./test-doubles.js";

const v0 = loadPlaybook("v0");
const v1 = loadPlaybook("v1");

/** The desk arm over a playbook decider. Counters are copied: the arm diffs two readings. */
const deskArm = (decide: PlaybookDecide) =>
  createDeskArm({
    label: decide.config.id ?? "playbook",
    name: "playbook",
    decide,
    counters: () => ({ ...decide.counters }),
  });

/** Text and decisions that must never be called. */
const noModel = () => createMockModelExecutors({});

describe("playbooks on the real desk", () => {
  test("v1 is right on every train and held-out scenario with no text-model call", async () => {
    const decide = createPlaybookDecide(v1, { executors: noModel(), judge: jevJudge().model });
    const { train, heldOut, all } = await runSplits(deskArm(decide));

    for (const [batch, scenarios] of [
      [train, SCENARIOS],
      [heldOut, HELD_OUT_SCENARIOS],
    ] as const) {
      expect(Object.fromEntries(batch.episodes.map((e) => [e.scenarioId, e.outcome]))).toEqual(
        Object.fromEntries(scenarios.map((s) => [s.id, s.expected])),
      );
    }
    expect(train.accuracy).toBe(1);
    expect(heldOut.accuracy).toBe(1);
    expect(all.violations).toBe(0);
    expect(all.modelCalls).toBe(0);
    // identity-fails: the failed identity check.
    expect(all.rejections).toBe(1);
  });

  test("v0 with an eager model: never a violation, but wrong and expensive", async () => {
    const decide = createPlaybookDecide(v0, {
      executors: createMockModelExecutors({ decisions: { "*": eagerChoice } }),
      judge: jevJudge().model,
    });
    const { all } = await runSplits(deskArm(decide));
    expect(all.violations).toBe(0);
    expect(all.judgeCalls).toBe(0);
    expect(all.modelCalls).toBeGreaterThan(all.episodes.length * 3);
    expect(all.accuracy).toBeLessThan(1);
  });
});

describe("one improvement round on the real desk", () => {
  test("v0 -> v1 passes every gate and is promoted", { timeout: 60_000 }, async () => {
    const log: string[] = [];
    const text = createMockModelExecutors({
      text: { proposePlaybook: v1 },
      decisions: { "*": eagerChoice },
    });
    const result = await runSelfImprovingRefundsExample({
      executors: text,
      judge: jevJudge().model,
      log: (line) => log.push(line),
    });

    expect(result.gates.every((gate) => gate.ok)).toBe(true);
    expect(result.promoted).toBe(true);
    expect(result.config.id).toBe("refund-playbook-v1");
    const { before, after } = result;
    if (!after) throw new Error("expected a replay");
    expect(after.all.violations).toBe(0);
    expect(after.all.accuracy).toBe(1);
    expect(objective(after.all)).toBeGreaterThan(objective(before.all));
    expect(log.at(-1)).toBe("Promoted refund-playbook-v1.");
  });
});

describe("the demo contract", () => {
  test("the desk idles in deciding with a renderable interaction and resumes from a persisted snapshot", async () => {
    const scenario = SCENARIOS.find((s) => s.id === "small-clean")!;
    const runtime = () =>
      createAgentRuntime(refundDeskMachine, { actors: createWorldActors(createWorld(scenario)) });

    // No decider at all: the plain desk waits for whoever drives it.
    const idle = await runToQuiescence(runtime(), {
      input: { ticket: scenario.ticket, customerId: scenario.customerId },
    });
    expect(idle.status).toBe("idle");
    expect(idle.snapshot.matches("deciding")).toBe(true);
    const interaction = getInteraction(idle.snapshot);
    // One button per concrete proposal the desk accepts, computed from context.
    expect(interaction?.choices?.map((choice) => choice.label)).toContain("Look up ORD-1001");
    expect(interaction?.label).toBe(
      `Ticket from C-1: "${scenario.ticket}" Turn 1: New ticket. Choose the next step.`,
    );

    const persist = (result: { persist(): unknown }) =>
      JSON.parse(JSON.stringify(result.persist()));
    const asking = await runToQuiescence(runtime(), {
      snapshot: persist(idle),
      event: { type: "VERIFY_IDENTITY" },
    });
    expect(asking.snapshot.matches("askingIdentity")).toBe(true);
    expect(getInteraction(asking.snapshot)).toMatchObject({
      textEvent: "IDENTITY_CLAIM",
      textField: "claim",
    });
    // Free text lands in the claim field.
    const claim = eventFromInteraction(asking.snapshot, { text: scenario.identityClaim });
    expect(claim).toEqual({ type: "IDENTITY_CLAIM", claim: scenario.identityClaim });

    const verified = await runToQuiescence(runtime(), { snapshot: persist(asking), event: claim });
    expect(verified.snapshot.matches("deciding")).toBe(true);
    expect(verified.snapshot.context.identityVerified).toBe(true);

    const done = await runToQuiescence(runtime(), {
      snapshot: persist(verified),
      event: { type: "CLOSE", reason: "not a refund request" },
    });
    expect(done.status).toBe("done");
    if (done.status !== "done") return;
    expect(done.output.outcome).toBe("close");
    expect(typeof done.output.summary).toBe("string");
  });
});

describe("the plain desk on the sample world (what the demo runs)", () => {
  const ada = CUSTOMERS.find((customer) => customer.id === "C-1")!;
  const persist = (result: { persist(): unknown }) => JSON.parse(JSON.stringify(result.persist()));

  /** Drives the desk with no actors bound: a person picks choices and types answers. */
  async function play(ticket: string, steps: ({ choice: string } | { text: string })[]) {
    // No `actors`: the machine's default tools act on the sample world.
    const runtime = () => createAgentRuntime(refundDeskMachine);
    let result = await runToQuiescence(runtime(), { input: { ticket, customerId: ada.id } });
    for (const step of steps) {
      if (result.status !== "idle") break;
      result = await runToQuiescence(runtime(), {
        snapshot: persist(result),
        event: eventFromInteraction(result.snapshot, step),
      });
    }
    return result;
  }

  test("a person finishes a ticket with payload choices and free text", async () => {
    const result = await play("ORD-1001 arrived broken. Can I get my $40 back?", [
      { choice: "Look up ORD-1001" },
      { choice: "Verify identity" },
      // The sample world wants the email on file, as a person would type it.
      { text: "It's ada@example.com" },
      { choice: "Refund $40" },
    ]);
    expect(result.status).toBe("done");
    expect(result.status === "done" && result.output.outcome).toBe("refund");
  });

  test("a customer reply typed as free text lands in the reply field", async () => {
    const result = await play("I want a refund for my cable.", [
      { choice: "Ask for the order number" },
      { text: "It was ORD-1001" },
    ]);
    expect(result.status === "idle" && result.snapshot.context.customerReplies).toEqual([
      "It was ORD-1001",
    ]);
    expect(getInteraction(result.snapshot)?.choices?.map((c) => c.label)).toContain(
      "Look up ORD-1001",
    );
  });

  test("each run gets a fresh sample world: a refund does not leak into the next run", async () => {
    for (let run = 0; run < 2; run++) {
      const result = await play("ORD-1001 arrived broken.", [
        { choice: "Look up ORD-1001" },
        { choice: "Verify identity" },
        { text: ada.identityAnswer },
        { choice: "Refund $40" },
      ]);
      expect(result.status === "done" && result.output.outcome, `run ${run}`).toBe("refund");
    }
  });

  test("a wrong identity claim fails the check, and the approver can reject in free text", async () => {
    const failed = await play("Refund ORD-1002, $240.", [
      { choice: "Verify identity" },
      { text: "I forgot" },
    ]);
    expect(failed.status === "idle" && failed.snapshot.context.rejections).toEqual([
      { proposal: "VERIFY_IDENTITY", reason: "identity check failed" },
    ]);

    const rejected = await play("Refund ORD-1002, $240.", [
      { choice: "Look up ORD-1002" },
      { choice: "Verify identity" },
      { text: ada.identityAnswer },
      { choice: "Request approval for $240" },
      { text: "Outside the return window" },
    ]);
    expect(rejected.status === "done" && rejected.output.summary).toBe(
      "Closed without a refund: approver rejected: Outside the return window.",
    );
  });
});
