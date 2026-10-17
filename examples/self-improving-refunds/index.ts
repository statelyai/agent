/**
 * Self-improving refund desk — malleable agent logic, fixed environment logic.
 *
 *   - The ENVIRONMENT (`desk.ts`, `refundDeskMachine`) is a plain XState
 *     machine. Its root `description` is the goal; its guards are the
 *     business invariants (verify identity before paying, never refund
 *     another customer's order or an already-refunded one, get a human
 *     APPROVE before any refund over $100); a sentinel state
 *     `illegallyIssued` re-checks every payout independently. desk.test.ts
 *     proves that sentinel unreachable with `canReach` over every proposal
 *     payload, tool result, and human answer within the turn budget.
 *   - The DECIDER sits at the boundary (`runDeskEpisode`): each turn,
 *     `decideNext` offers only the legal, concrete proposals (a closed
 *     choice) and any decide executor picks one: a raw model, a decision
 *     model (Jev), or a playbook. Every episode is journaled to an event-log
 *     store; those threads are the traces.
 *   - The POLICY (`playbook.ts`, `playbooks/*.json`) is a JSON agent
 *     workflow the agent rewrites between batches (`improve.ts`): reflect on
 *     the traces against the goal, gate the candidate with
 *     `verifyAgentConfig` and a probe of the real boundary, replay train and
 *     held-out scenarios, and promote only when nothing breaks a rule and the
 *     goal-derived `objective` rises.
 *
 * The policy changes; the environment never does. Whatever a candidate
 * proposes, the desk offers only legal steps, so the worst a bad rewrite can
 * do is cost turns and fail the replay gate.
 *
 * `runSelfImprovingRefundsExample` runs one improvement round from
 * `playbooks/v0.json` (one model decision per turn, rules in the prompt) over
 * the real desk and prints the before/after metrics and the gate list. The
 * six-arm benchmark (raw tool loop, desk + raw model, desk + Jev with and
 * without lookahead, desk + playbook before and after) lives in `benchmark.ts`.
 *
 * Run: OPENAI_API_KEY=... TYPESAFE_AI_API_KEY=... npx tsx examples/self-improving-refunds/index.ts
 */
import { openai } from "@ai-sdk/openai";
import type { Experimental_DecisionModel } from "ai";
import { createAiSdkExecutors, parseModelRef } from "@statelyai/agent/ai-sdk";
import type { BatchMetrics } from "./contract.js";
import { improvePlaybook, objective, type ImprovementResult } from "./improve.js";
import { loadPlaybook, type PlaybookExecutors } from "./playbook.js";

export { HELD_OUT_SCENARIOS, SCENARIOS, createWorld, runBatch } from "./contract.js";
export {
  DESK_GOAL,
  createDeskArm,
  createWorldActors,
  refundDeskMachine,
  refundDeskSchemas,
  runDeskEpisode,
} from "./desk.js";
export { createPlaybookDecide, loadPlaybook, lowerPlaybook } from "./playbook.js";
export { improvePlaybook, objective } from "./improve.js";

function formatMetrics(label: string, metrics: BatchMetrics): string {
  return (
    `${label}: accuracy ${(metrics.accuracy * 100).toFixed(0)}%, ` +
    `${metrics.violations} violations, ${metrics.modelCalls} model calls, ` +
    `${metrics.judgeCalls} judge calls, ${metrics.rejections} rejections, ` +
    `objective ${objective(metrics).toFixed(3)}`
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
    executors,
    ...(options.judge ? { judge: options.judge } : {}),
  });

  for (const [phase, split] of [
    ["before", result.before],
    ["after ", result.after],
  ] as const) {
    if (!split) continue;
    log(formatMetrics(`${phase}  train   `, split.train));
    log(formatMetrics(`${phase}  held-out`, split.heldOut));
  }
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
