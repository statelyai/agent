/**
 * Code-review loop: generate, verify, check, triage. The environment is fixed;
 * the triage policy is learned.
 *
 *   generate → (self-check ∥ independent review) → automated checks →
 *     ship (computed) | RETRY with feedback | ESCALATE → human review → generate
 *
 *   - The ENVIRONMENT (`environment.ts`, `codeReviewLoopMachine`) is a
 *     TypeScript machine. Its root `description` is the goal; its guards are
 *     the invariants: nothing ships without passing checks and reviewer
 *     approval unless a person approves it; at most `MAX_ROUNDS` autonomous
 *     rounds; no RETRY on an issue the reviewer marked novel or on a check
 *     failure outside every visible test. A sentinel state `illegallyShipped`
 *     re-checks every ship; environment.test.ts proves it unreachable with
 *     `canReach` over every author, reviewer, check result, triage choice,
 *     and human answer.
 *   - The POLICY (`policy.ts`, `policies/*.json`) is a JSON agent workflow
 *     that answers the one decision point, `agent.decide` with model
 *     `"triage"`: RETRY with which feedback, or ESCALATE with which reason,
 *     always from a closed list of legal options.
 *   - TRACES: every task run is a thread `<split>/<policyVersion>/<taskId>`
 *     in an event-log store (`file-store.ts`, JSONL per thread).
 *   - IMPROVE (`improve.ts`): reflect on the train traces with the goal, the
 *     objective, and both machines as `describeMachine` text; gate the
 *     candidate with `verifyAgentConfig` and a probe of the real triage
 *     boundary; replay train and held-out; promote only on a strict
 *     objective gain with no invariant violation.
 *   - TASKS (`tasks.ts`, `fixtures/`): eight tiny coding tasks with visible
 *     tests (run every round) and hidden tests (run only by the objective).
 *     Two have a spec that contradicts its own tests: the right move is to
 *     escalate them.
 *
 * The Claude Code host (`claude-code.ts`, `run.ts`) runs every model call
 * through `claude -p --output-format json`. See README.md.
 *
 * `runCodeReviewLoopExample` runs tasks (default: `clamp`) with a policy
 * (default: v1) and returns the batch metrics. Defaults to Claude Code
 * executors and the real `node --test` runner; tests pass mocks.
 *
 * Run: pnpm exec tsx examples/code-review-loop/index.ts   (needs the `claude` CLI, logged in)
 */
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import type { AgentDecisionExecutor, AgentRequestExecutor } from "@statelyai/agent";
import { runBatch, type BatchMetrics } from "./bench.js";
import { nodeTestRunner, type TestRunner } from "./checks.js";
import { createClaudeCodeExecutors } from "./claude-code.js";
import { createPolicyDecide, loadPolicy, withPolicy, type IssueClassifier } from "./policy.js";
import { getTask } from "./tasks.js";

export {
  ESCALATE_REASONS,
  MAX_ROUNDS,
  MAX_TOTAL_ROUNDS,
  REVIEW_GOAL,
  codeReviewLoopMachine,
  createRunChecks,
  retryBlocker,
  triagePayloads,
} from "./environment.js";
export {
  createPolicyDecide,
  judgeClassifier,
  loadPolicy,
  lowerPolicy,
  withPolicy,
} from "./policy.js";
export { improvePolicy, OBJECTIVE_TEXT } from "./improve.js";
export { runBatch, runEpisode, scoreEpisode } from "./bench.js";
export { nodeTestRunner } from "./checks.js";
export { createClaudeCodeExecutors } from "./claude-code.js";
export { createFileEventLogStore } from "./file-store.js";
export { ALL_TASKS, HELD_OUT_TASKS, TRAIN_TASKS, getTask } from "./tasks.js";

export async function runCodeReviewLoopExample(
  options: {
    taskIds?: string[];
    policy?: "v0" | "v1";
    executors?: { generateText: AgentRequestExecutor; decide?: AgentDecisionExecutor };
    classify?: IssueClassifier;
    runner?: TestRunner;
    log?: (line: string) => void;
  } = {},
): Promise<BatchMetrics> {
  const log = options.log ?? console.log;
  const cli = options.executors && options.classify ? undefined : createClaudeCodeExecutors();
  const executors = options.executors ?? cli!;
  const decide = createPolicyDecide(loadPolicy(options.policy ?? "v1"), {
    classify: options.classify ?? cli!.classify,
    ...(executors.decide ? { executors: { decide: executors.decide } } : {}),
  });
  const metrics = await runBatch(
    options.policy ?? "v1",
    (options.taskIds ?? ["clamp"]).map(getTask),
    {
      executors: withPolicy(executors, decide),
      runner: options.runner ?? nodeTestRunner,
      policyVersion: options.policy ?? "v1",
    },
  );
  for (const episode of metrics.episodes) {
    log(
      `${episode.taskId}: ${episode.outcome} after ${episode.rounds} round(s), ` +
        `hidden ${episode.hiddenPassed === null ? "-" : episode.hiddenPassed ? "pass" : "FAIL"}, ` +
        `score ${episode.score.toFixed(2)}`,
    );
  }
  log(`objective ${metrics.objective.toFixed(3)}`);
  return metrics;
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
// Run directly: compare canonical file URLs, so a path with `#`, `?` or a
// symlink still matches.
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  if (spawnSync("claude", ["--version"]).status !== 0) {
    console.error("Install and log in to the Claude Code CLI (`claude`) to run this example.");
    process.exit(1);
  }
  runCodeReviewLoopExample().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
