/**
 * Self-improving refund desk — the agent rewrites its own way of working, and
 * the business rules stay out of its reach.
 *
 * Two layers:
 *   - The OUTER machine (`desk.ts`, `refundDeskMachine`) encodes the business
 *     invariants: verify identity before paying, never refund another
 *     customer's order or an already-refunded one, and get a human APPROVE
 *     before any refund over $100. Each one is a guard on a proposal event,
 *     and a sentinel state `illegallyIssued` re-checks the payout
 *     independently. desk.test.ts proves that sentinel unreachable for every
 *     sequence of proposals, payloads, tool results, and human answers within
 *     the turn budget.
 *   - The INNER playbook (`playbook.ts`, `playbooks/*.json`) is a JSON agent
 *     workflow that picks the desk's next proposal. It is the part the agent
 *     rewrites between batches (`improve.ts`): propose a new config, validate
 *     it, check its vocabulary, lower it, lint it, explore every branch, replay
 *     the batch, and promote it only when it is no less accurate, has no
 *     violations, and is strictly cheaper.
 *
 * The playbook changes; the invariants never do. Whatever a candidate
 * proposes, the desk's guards decide whether it is legal, so the worst a bad
 * rewrite can do is cost turns and get refused at the replay gate.
 *
 * `runSelfImprovingRefundsExample` runs one improvement round from
 * `playbooks/v0.json` (one model decision per turn, rules in the prompt) over
 * the real desk and prints the before/after batch metrics and the gate list.
 * The three-arm benchmark (raw tool loop, desk with a raw-model decider, desk
 * with a learned playbook) lives in the sibling `benchmark.ts`.
 *
 * Run: OPENAI_API_KEY=... TYPESAFE_AI_API_KEY=... npx tsx examples/self-improving-refunds/index.ts
 */
import { openai } from "@ai-sdk/openai";
import type { Experimental_DecisionModel } from "ai";
import { createAiSdkExecutors, parseModelRef } from "@statelyai/agent/ai-sdk";
import { SCENARIOS, type BatchMetrics } from "./contract.js";
import { createDeskArm } from "./desk.js";
import { improvePlaybook, type ImprovementResult } from "./improve.js";
import { loadPlaybook, type PlaybookExecutors } from "./playbook.js";

export { SCENARIOS, createWorld, runBatch } from "./contract.js";
export {
  createDeskArm,
  createWorldActors,
  refundDeskMachine,
  refundDeskSchemas,
  runDeskEpisode,
} from "./desk.js";
export { createPlaybookDecide, loadPlaybook, lowerPlaybook } from "./playbook.js";
export { improvePlaybook } from "./improve.js";

function formatMetrics(metrics: BatchMetrics): string {
  return (
    `${metrics.label}: accuracy ${(metrics.accuracy * 100).toFixed(0)}%, ` +
    `${metrics.violations} violations, ${metrics.modelCalls} model calls, ` +
    `${metrics.judgeCalls} judge calls, ${metrics.rejections} rejections`
  );
}

/**
 * One improvement round over the real desk, starting from `playbooks/v0.json`.
 * Defaults to the AI SDK with OpenAI for text and decisions (`OPENAI_API_KEY`)
 * and Jev for the `classifyTicket` judgment (`TYPESAFE_AI_API_KEY`); tests pass
 * mock executors and a mock judge.
 */
export async function runSelfImprovingRefundsExample(
  options: {
    executors?: PlaybookExecutors;
    judge?: Experimental_DecisionModel;
    log?: (line: string) => void;
  } = {},
): Promise<ImprovementResult> {
  const log = options.log ?? console.log;
  const executors =
    options.executors ??
    createAiSdkExecutors({ resolveModel: (ref: string) => openai(parseModelRef(ref).modelId) });

  const result = await improvePlaybook({
    current: loadPlaybook("v0"),
    arm: (decide) =>
      createDeskArm({
        label: decide.config.id ?? "playbook",
        decide,
        // A copy: the arm diffs two readings, so the same live object would read 0.
        counters: () => ({ ...decide.counters }),
      }),
    executors,
    ...(options.judge ? { judge: options.judge } : {}),
    scenarios: SCENARIOS,
  });

  log(`before  ${formatMetrics(result.before)}`);
  if (result.after) log(`after   ${formatMetrics(result.after)}`);
  for (const gate of result.gates) {
    log(`  ${gate.ok ? "pass" : "FAIL"} ${gate.name}${gate.detail ? `: ${gate.detail}` : ""}`);
  }
  log(
    result.promoted
      ? `Promoted ${result.config.id ?? "the proposed playbook"}.`
      : `Kept ${result.config.id ?? "the current playbook"}.`,
  );
  return result;
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY || !process.env.TYPESAFE_AI_API_KEY) {
    console.error("Set OPENAI_API_KEY and TYPESAFE_AI_API_KEY to run this example.");
    process.exit(1);
  }
  runSelfImprovingRefundsExample().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
