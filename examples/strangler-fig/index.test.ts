import { expect, test } from "vitest";
import { canReach, checkParity, createRecorder } from "@statelyai/agent/testing";
import { MAX_ATTEMPTS, runTicket } from "./before.js";
import { createFakeWorld } from "./effects.js";
import { runStranglerFigExample, SCENARIOS, step0, supportMachine } from "./index.js";
import { runTicketStep1 } from "./step1.js";

const effects = (scenario: (typeof SCENARIOS)[number]) =>
  createFakeWorld({ flakyClassify: scenario.flakyClassify }).effects;

test("step 0: the wrapped workflow has the same effects and result as before.ts", async () => {
  const report = await checkParity({
    scenarios: SCENARIOS,
    effects,
    before: runTicket,
    after: (ticket, fx) => step0.run(ticket, { effects: fx }),
  });
  expect(report.scenarios.filter((row) => !row.equivalent)).toEqual([]);
  expect(
    report.scenarios.map((row) => "output" in row.before && row.before.output.outcome),
  ).toEqual(["refunded", "escalated", "answered", "refunded", "escalated"]);
});

test("step 0: a recorder on a normal run is the golden recording", async () => {
  const recorder = createRecorder();
  await step0.run(SCENARIOS[0]!.input, { recorder });
  expect(recorder.recording.effects.map((effect) => effect.kind === "call" && effect.name)).toEqual(
    [
      "generate",
      "lookupOrder",
      "issueRefund",
      "generate",
      false, // the output
    ],
  );
});

test("step 1: carving the classify phase keeps parity", async () => {
  const report = await checkParity({
    scenarios: SCENARIOS,
    effects,
    before: runTicket,
    after: runTicketStep1,
  });
  expect(report.scenarios.filter((row) => !row.equivalent)).toEqual([]);
});

test("checkParity catches a carve that drops the retry", async () => {
  const report = await checkParity({
    scenarios: SCENARIOS.filter((scenario) => scenario.id === "flaky-model"),
    effects,
    before: runTicket,
    // One attempt only: the port gives up where the original retried.
    after: (ticket, fx) =>
      runTicketStep1(ticket, {
        ...fx,
        generate: (async (request: Parameters<typeof fx.generate>[0]) => {
          if (request.task === "classify") {
            return fx
              .generate(request)
              .catch(() => ({ intent: "other", orderId: null, amount: null }));
          }
          return fx.generate(request);
        }) as typeof fx.generate,
      }),
  });
  expect(report.equivalent).toBe(false);
});

test("step 1 proves what step 0 could not: the classifier runs at most MAX_ATTEMPTS times", async () => {
  const resolved = { outcome: "escalated", reply: "", refundId: null };
  const tooMany = await canReach(
    supportMachine,
    (snapshot) => snapshot.context.attempts > MAX_ATTEMPTS,
    {
      input: SCENARIOS[0]!.input,
      outputs: {
        classify: [{ intent: "refund", orderId: "A-100", amount: 20 }],
        resolve: [resolved],
      },
      errors: { classify: new Error("model overloaded") },
      maxDepth: 12,
    },
  );
  expect(tooMany).toMatchObject({ reachable: false, complete: true });
  // Not vacuous: giving up after MAX_ATTEMPTS failures still resolves the ticket.
  const gaveUp = await canReach(
    supportMachine,
    (snapshot) => snapshot.status === "done" && snapshot.context.attempts === MAX_ATTEMPTS,
    {
      input: SCENARIOS[0]!.input,
      outputs: { resolve: [resolved] },
      errors: { classify: new Error("503") },
    },
  );
  expect(gaveUp.reachable).toBe(true);
});

test("the example entry point runs both checks", async () => {
  const { step0: wrapped, step1: carved } = await runStranglerFigExample();
  expect([wrapped.equivalent, carved.equivalent]).toEqual([true, true]);
});

test("the step 1 runner passes run options through: a store journals the thread", async () => {
  const { createInMemoryEventLogStore } = await import("@statelyai/agent/log");
  const store = createInMemoryEventLogStore();
  const scenario = SCENARIOS[0]!;
  await runTicketStep1(scenario.input, effects(scenario), {
    store,
    threadId: `test:step1:${scenario.id}`,
  });
  const entries = await store.read(`test:step1:${scenario.id}`);
  expect(entries.length).toBeGreaterThan(0);
});

test("a retried refund with the same ticket is issued once", async () => {
  const world = createFakeWorld();
  const first = await world.effects.issueRefund("A-100", 20, "refund:T-1");
  const again = await world.effects.issueRefund("A-100", 20, "refund:T-1");
  expect(again).toEqual(first);
  expect(world.refunds).toHaveLength(1);
});
