/**
 * Running tasks and scoring them.
 *
 * `runEpisode` drives one task through the environment, journaled to an
 * event-log store under `<split>/<policyVersion>/<taskId>`. `scoreEpisode`
 * is the objective per task, read from ground truth: the terminal state, and
 * the HIDDEN tests run against whatever shipped. A model never grades a run.
 *
 *   shipped, hidden tests pass        1   (a person's APPROVE included)
 *   escalated a novel-expected task   1   (then rejected, failed, or unanswered)
 *   escalated a resolvable task       0.5
 *   shipped, hidden tests fail        0
 *   failed without escalating         0
 *   minus 0.05 per round, floored at 0
 *
 * A correct escalation scores the same as a clean ship after the same number
 * of rounds, so escalating a novel task is never penalized against shipping
 * it; it only costs the rounds spent before escalating. Any run that reaches
 * `illegallyShipped` makes the batch objective -Infinity.
 */
import type { AnyMachineSnapshot } from "xstate";
import {
  type AgentDecisionExecutor,
  type AgentEventLogStore,
  type AgentLogEntry,
  type AgentRequestExecutor,
  type AgentRunInit,
  type ChosenEvent,
  runAgent,
} from "@statelyai/agent";
import { createInMemoryEventLogStore, getDecisionAttempts } from "@statelyai/agent/log";
import type { TestRunner } from "./checks.js";
import { codeReviewLoopMachine, createRunChecks } from "./environment.js";
import type { Task } from "./tasks.js";

export const ROUND_COST = 0.05;

export type Outcome = "shipped" | "escalated" | "rejected" | "failed" | "violation";

export type Episode = {
  taskId: string;
  label: Task["label"];
  threadId: string;
  /**
   * The outcome the objective scores, from the final state: `shipped` for any
   * ship (a person's APPROVE included); `escalated` for a run that reached a
   * person and then was rejected, failed, or is still waiting.
   */
  outcome: Outcome;
  /** Rounds spent before that outcome (for `escalated`, before the first escalation). */
  rounds: number;
  /** Hidden tests on the shipped patch; null when nothing shipped. */
  hiddenPassed: boolean | null;
  score: number;
  /** Triage choices the environment refused before one landed (from `entry.attempts`). */
  refused: number;
  /** One line per journaled step, read back from the thread. */
  trail: string[];
  /** Where the run ended after any human answers (`humanReview` when nobody answered). */
  finalState: string;
};

export function scoreEpisode(
  task: Pick<Task, "label">,
  episode: Pick<Episode, "outcome" | "rounds" | "hiddenPassed">,
): number {
  const base =
    episode.outcome === "shipped"
      ? episode.hiddenPassed
        ? 1
        : 0
      : episode.outcome === "escalated"
        ? task.label === "novel-expected"
          ? 1
          : 0.5
        : 0;
  return Math.max(0, base - ROUND_COST * episode.rounds);
}

export type BatchMetrics = {
  label: string;
  episodes: Episode[];
  /** Mean score, or -Infinity when any run broke the ship invariant. */
  objective: number;
  violations: number;
  shipped: number;
  escalated: number;
  rounds: number;
};

export function summarize(label: string, episodes: Episode[]): BatchMetrics {
  const violations = episodes.filter((e) => e.outcome === "violation").length;
  const mean = episodes.reduce((n, e) => n + e.score, 0) / Math.max(episodes.length, 1);
  return {
    label,
    episodes,
    objective: violations > 0 ? Number.NEGATIVE_INFINITY : mean,
    violations,
    shipped: episodes.filter((e) => e.outcome === "shipped").length,
    escalated: episodes.filter((e) => e.outcome === "escalated").length,
    rounds: episodes.reduce((n, e) => n + e.rounds, 0),
  };
}

/** Answers a run idle in `humanReview`; undefined leaves it waiting there. */
export type HumanReviewer = (snapshot: AnyMachineSnapshot) => Promise<ChosenEvent | undefined>;

export type EpisodeOptions = {
  /** Text requests (author, self-check, reviewer) and the triage decision (the policy). */
  executors: { generateText: AgentRequestExecutor; decide: AgentDecisionExecutor };
  /** Runs the visible suite in `runChecks` and the hidden suite for the objective. */
  runner: TestRunner;
  store?: AgentEventLogStore;
  /** Default `<split>/<policyVersion>/<taskId>`. Must be unused in `store`. */
  threadId?: string;
  policyVersion?: string;
  human?: HumanReviewer;
};

/**
 * Runs one task to a terminal state or a human wait, answering the wait with
 * `human` when given. Each answer resumes from the previous pass's persisted
 * snapshot and appends to the same thread.
 */
export async function runEpisode(task: Task, options: EpisodeOptions): Promise<Episode> {
  const store = options.store ?? createInMemoryEventLogStore();
  const threadId =
    options.threadId ?? `${task.split}/${options.policyVersion ?? "policy"}/${task.id}`;
  const actors = { runChecks: createRunChecks(options.runner) };
  const run = (init: { input: { taskId: string } } | { event: ChosenEvent }) =>
    runAgent(codeReviewLoopMachine, {
      executors: options.executors,
      actors,
      store,
      threadId,
      ...(init as AgentRunInit<typeof codeReviewLoopMachine>),
    });

  let result = await run({ input: { taskId: task.id } });
  let escalatedAt: number | undefined;
  while (result.status === "idle") {
    if (!result.snapshot.matches("humanReview")) {
      throw new Error(`task ${task.id}: idle in ${JSON.stringify(result.snapshot.value)}`);
    }
    escalatedAt ??= result.snapshot.context.round;
    const event = await options.human?.(result.snapshot);
    if (!event) break;
    // Resume from the thread in the store: the log is the source of truth.
    result = await run({ event });
  }
  if (result.status === "error") {
    throw new Error(`task ${task.id}: run errored: ${String(result.error)}`);
  }

  const entries = await store.read(threadId);
  const finalState = JSON.stringify(result.snapshot.value).replaceAll('"', "");
  let outcome: Outcome;
  let rounds: number;
  let hiddenPassed: boolean | null = null;
  // Scored from the FINAL state: anything that shipped (a person's APPROVE
  // included) is judged by the hidden tests; a run a person rejected, that
  // failed after escalating, or that is still waiting scores as the escalation.
  if (result.status === "done" && result.output.outcome === "violation") {
    outcome = "violation";
    rounds = result.output.rounds;
  } else if (result.status === "done" && result.output.outcome === "shipped") {
    outcome = "shipped";
    rounds = result.output.rounds;
    hiddenPassed = (await options.runner(task, result.output.patch, "hidden")).passed;
  } else if (escalatedAt !== undefined) {
    outcome = "escalated";
    rounds = escalatedAt;
  } else if (result.status === "done") {
    outcome = result.output.outcome;
    rounds = result.output.rounds;
  } else {
    throw new Error(`task ${task.id}: run settled '${result.status}'`);
  }

  return {
    taskId: task.id,
    label: task.label,
    threadId,
    outcome,
    rounds,
    hiddenPassed,
    score: scoreEpisode(task, { outcome, rounds, hiddenPassed }),
    refused: getDecisionAttempts(entries).reduce((n, e) => n + e.attempts.length, 0),
    trail: trailFromLog(entries),
    finalState,
  };
}

export async function runBatch(
  label: string,
  tasks: Task[],
  options: Omit<EpisodeOptions, "threadId">,
): Promise<BatchMetrics> {
  const episodes: Episode[] = [];
  for (const task of tasks) episodes.push(await runEpisode(task, options));
  return summarize(label, episodes);
}

// ─── Traces ───

function describeEvent(event: ChosenEvent & Record<string, unknown>): string | undefined {
  switch (event.type) {
    case "RETRY":
      return `RETRY (${String(event["focus"])})`;
    case "ESCALATE":
      return `ESCALATE (${String(event["reason"])})`;
    case "APPROVE":
      return "a person approved";
    case "REQUEST_CHANGES":
      return `a person requested changes: ${String(event["notes"])}`;
    case "REJECT":
      return `a person rejected: ${String(event["reason"])}`;
    default:
      return undefined;
  }
}

function describeOutput(actorId: string, output: unknown): string | undefined {
  const value = (output as { result?: unknown } | null)?.result ?? output;
  if (actorId === "writePatch") return "patch written";
  if (actorId === "selfCheck") {
    const check = value as { ok: boolean; concerns: string[] };
    return `self-check ${check.ok ? "ok" : `concerns: ${check.concerns.join("; ")}`}`;
  }
  if (actorId === "review") {
    const review = value as { approved: boolean; issues: { severity: string; note: string }[] };
    const issues = review.issues.map((i) => `[${i.severity}] ${i.note}`).join("; ");
    return `review ${review.approved ? "approved" : "not approved"}${issues ? `: ${issues}` : ""}`;
  }
  if (actorId === "runChecks") {
    const checks = value as { passed: boolean; failingTests: string[] };
    return checks.passed
      ? "checks passed"
      : `checks failed: ${checks.failingTests.join(", ") || "(no test name)"}`;
  }
  return undefined;
}

/**
 * One run's trail, projected from its event-log thread: one line per
 * journaled input (`round 1: checks failed: trims leading and trailing
 * dashes`, `round 1: RETRY (tests)`), with each triage choice the
 * environment refused before it (`round 2: refused RETRY (all) (rejected-by-guard)`).
 */
export function trailFromLog(entries: readonly AgentLogEntry[]): string[] {
  const refused = new Map(getDecisionAttempts(entries).map((e) => [e.index, e.attempts]));
  const trail: string[] = [];
  let round = 0;
  for (const { event, index } of entries) {
    const e = event as ChosenEvent & Record<string, unknown>;
    for (const attempt of refused.get(index) ?? []) {
      const tried = attempt.event
        ? (describeEvent(attempt.event as ChosenEvent & Record<string, unknown>) ??
          attempt.event.type)
        : "(no event)";
      trail.push(`round ${round}: refused ${tried} (${attempt.failure})`);
    }
    if (e.type === "xstate.done.actor" && typeof e["actorId"] === "string") {
      if (e["actorId"] === "writePatch") round += 1;
      const line = describeOutput(e["actorId"], e["output"]);
      if (line) trail.push(`round ${round}: ${line}`);
    } else if (e.type === "xstate.error.actor" && typeof e["actorId"] === "string") {
      trail.push(`round ${round}: ${e["actorId"]} failed`);
    } else {
      const line = describeEvent(e);
      if (line) trail.push(`round ${round}: ${line}`);
    }
  }
  return trail;
}
