/**
 * The strangler-fig path on a support workflow: `before.ts` unchanged,
 * `step0.ts` wrapped, `step1.ts` with the classify phase carved into states.
 * `index.test.ts` checks each step against `before.ts` with `checkParity`.
 */
import { checkParity } from "@statelyai/agent/testing";
import { runTicket, type Ticket } from "./before.js";
import { createFakeWorld } from "./effects.js";
import { step0 } from "./step0.js";
import { runTicketStep1, supportMachine } from "./step1.js";

export { supportMachine, runTicketStep1 } from "./step1.js";
export { step0 } from "./step0.js";

export const SCENARIOS: Array<{ id: string; input: Ticket; flakyClassify?: number }> = [
  { id: "small-refund", input: { id: "T-1", message: "Mug A-100 arrived chipped, refund $20." } },
  { id: "over-limit", input: { id: "T-2", message: "Desk A-200 is cracked, refund $240." } },
  { id: "status", input: { id: "T-3", message: "Where is A-200?" } },
  {
    id: "flaky-model",
    input: { id: "T-4", message: "Refund $20 on A-100 please." },
    flakyClassify: 2,
  },
  { id: "model-down", input: { id: "T-5", message: "Where is A-100?" }, flakyClassify: 3 },
];

/** Checks both steps against `before.ts` on every scenario, with no API key. */
export async function runStranglerFigExample() {
  const effects = (scenario: (typeof SCENARIOS)[number]) =>
    createFakeWorld({ flakyClassify: scenario.flakyClassify }).effects;
  const [wrapped, carved] = await Promise.all([
    checkParity({
      scenarios: SCENARIOS,
      effects,
      before: runTicket,
      after: (ticket, fx) => step0.run(ticket, { effects: fx }),
    }),
    checkParity({ scenarios: SCENARIOS, effects, before: runTicket, after: runTicketStep1 }),
  ]);
  return { step0: wrapped, step1: carved, machine: supportMachine };
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  void runStranglerFigExample().then(({ step0: wrapped, step1: carved }) => {
    for (const [name, report] of [
      ["step0", wrapped],
      ["step1", carved],
    ] as const) {
      for (const row of report.scenarios) {
        console.log(`${name} ${row.id}: ${row.equivalent ? "same" : row.divergences[0]?.message}`);
      }
    }
  });
}
