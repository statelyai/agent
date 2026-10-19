/**
 * The self-improvement loop: the agent rewrites its POLICY (the JSON triage
 * config), never its ENVIRONMENT (the review loop).
 *
 *   run train + held-out with the current policy        → before (traces in the store)
 *   reflect: one `proposePolicy` text request           → a candidate config
 *     the prompt: the goal, the objective, the environment and policy as
 *     `describeMachine` text, the train metrics, and each train thread the
 *     store lists (`listThreads`), with its trail and its refused triage
 *     choices (`getDecisionAttempts`) read back from the log
 *   gates: verifyAgentConfig (validate → vocabulary → lower → lint → explore),
 *     then `outputs` (the candidate answers the real triage boundary from probe states)
 *     a failing gate's `detail` goes back as a repair prompt (≤ maxRepairs)
 *   replay: train + held-out with the candidate         → after
 *   promote iff zero violations on both splits, the held-out objective is no
 *     worse, and the combined objective is strictly better
 */
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  createTextLogic,
  describeMachine,
  type AgentDecisionExecutor,
  type AgentEventLogStore,
  type AgentExecutorDecisionRequest,
  type AgentRequestExecutor,
  type AgentWorkflowConfig,
  type ChosenEvent,
} from "@statelyai/agent";
import { createInMemoryEventLogStore } from "@statelyai/agent/log";
import { verifyAgentConfig, type VerifyAgentConfigResult } from "@statelyai/agent/validate";
import { ROUND_COST, runBatch, summarize, trailFromLog, type BatchMetrics } from "./bench.js";
import type { TestRunner } from "./checks.js";
import {
  ESCALATE_REASONS,
  MAX_ROUNDS,
  REVIEW_GOAL,
  codeReviewLoopMachine,
  triageInput,
  type ReviewContext,
} from "./environment.js";
import {
  POLICY_EVENTS,
  POLICY_MODEL,
  ajvCompileSchema,
  createPolicyDecide,
  lowerPolicy,
  policyActorNames,
  policyInputOf,
  withPolicy,
  withPolicyInterface,
  type IssueClassifier,
} from "./policy.js";
import { HELD_OUT_TASKS, TRAIN_TASKS, briefOf, getTask, type Task } from "./tasks.js";

export const OBJECTIVE_TEXT =
  "Per task: shipped and the hidden tests pass = 1; escalated a novel-expected task = 1; " +
  `escalated a resolvable task = 0.5; shipped but the hidden tests fail = 0; minus ${ROUND_COST} ` +
  "per round, floored at 0. The objective is the mean over tasks; any run that reaches " +
  "illegallyShipped makes it -Infinity. Higher is better. A correct escalation scores the same " +
  "as a clean ship after the same number of rounds.";

export type SplitMetrics = { train: BatchMetrics; heldOut: BatchMetrics; all: BatchMetrics };

export type Gate =
  | VerifyAgentConfigResult["gates"][number]
  | { name: "outputs" | "replay"; ok: boolean; detail?: string };

export type ImprovementResult = {
  promoted: boolean;
  /** The policy now in force: `proposed` when promoted, else `current`. */
  config: AgentWorkflowConfig;
  /** The last candidate the model proposed. */
  proposed?: AgentWorkflowConfig;
  before: SplitMetrics;
  /** Only set when a candidate passed every static gate and was replayed. */
  after?: SplitMetrics;
  gates: Gate[];
  repairs: number;
  store: AgentEventLogStore;
};

export type ImproveOptions = {
  current: AgentWorkflowConfig;
  /** Text requests: the author, self-check, reviewer, and the reflection (`proposePolicy`). */
  executors: { generateText: AgentRequestExecutor };
  /** The policy's own `agent.decide` (model "policy"), when a policy uses one. */
  policyDecide?: AgentDecisionExecutor;
  /** Backs `classifyIssue`. */
  classify: IssueClassifier;
  runner: TestRunner;
  train?: Task[];
  heldOut?: Task[];
  maxRepairs?: number;
  store?: AgentEventLogStore;
  /** Progress lines (one per batch and gate). */
  log?: (line: string) => void;
};

// ─── Reflection ───

/** The reflection request. The mock model keys on its name. */
export const proposePolicy = createTextLogic({
  name: "proposePolicy",
  schemas: {
    input: z.object({ prompt: z.string() }),
    output: z.looseObject({ initial: z.string(), states: z.record(z.string(), z.unknown()) }),
  },
  model: "reflector",
  system:
    "You improve the POLICY a code-review loop uses to triage a patch that did not ship: a " +
    "JSON agent workflow config. The ENVIRONMENT (the loop machine) is fixed: it writes, " +
    "reviews, and checks patches, ships only what passes, offers the policy only legal " +
    "options, and refuses everything else. Return one complete policy config as JSON that " +
    "scores higher on the objective.",
  prompt: ({ input }) => input.prompt,
});

const RULES = [
  'Input is the triage facts (round, roundLimit, checksPassed, failingTests, unattributedFailure, checkOutput, reviewApproved, issues[{severity, note}], selfCheckOk, concerns, retryBlocked) plus the offered options: `retry.all`, `retry.tests`, `retry.review` (each a full RETRY event, absent when not offered), `escalateReasons`, and `payloads` (offered options per type). Keep them in context: `"context": { "facts": "{{ input }}", ... }`.',
  'End in a `type: final` state whose `output` is ONE event, usually `"{{ context.proposal }}"`: an offered RETRY as a whole (`"{{ context.facts.retry.tests }}"`), or `{ "type": "ESCALATE", "reason": <one of the reasons> }`. Anything not offered is refused.',
  `ESCALATE reasons: ${ESCALATE_REASONS.map((r) => JSON.stringify(r)).join(", ")}. RETRY is offered only when the environment allows it.`,
  "Values are JSON literals or `{{ dot.path }}` templates over input/context/event. A whole-string template keeps the value's type. Array items are paths too: `{{ context.facts.issues.0 }}`.",
  "Guards are `{{ path }}` only (a truthy test: no comparisons, operators, or negation). Use `type: choice` states with a first-match `choice` list; the last branch has no guard.",
  "Actor classifyIssue: input { issues, concerns, failingTests }; onDone reads {{ event.output.novel }} (true when the task itself is broken). One judge call each. Give it an onError.",
  `agent.decide: input { name, model: "${POLICY_MODEL}", system, prompt, allowedEvents: subset of ${POLICY_EVENTS.join(", ")}, payloads: "{{ context.facts.payloads }}" }. Handle every allowed event in the state's \`on\` (assign "{{ event }}" to proposal, target the final state). One model call each.`,
  "Do not declare schemas.input/events/output, requests, or actors: the host injects them. No named guards or actions.",
].map((rule) => `- ${rule}`);

const fmt = (value: number) => (Number.isFinite(value) ? value.toFixed(3) : String(value));

export function metricsLine(metrics: BatchMetrics): string {
  return (
    `objective ${fmt(metrics.objective)}, shipped ${metrics.shipped}, escalated ${metrics.escalated}, ` +
    `rounds ${metrics.rounds}, violations ${metrics.violations}`
  );
}

/** The train episodes, read back from the store: every thread under `prefix` (`listThreads`). */
async function trainTraces(
  store: AgentEventLogStore,
  prefix: string,
  metrics: BatchMetrics,
): Promise<string[]> {
  if (!store.listThreads) {
    throw new Error("improvePolicy: the event-log store must implement listThreads.");
  }
  const threadIds: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.listThreads({ prefix, limit: 100, ...(cursor ? { cursor } : {}) });
    threadIds.push(...page.threadIds);
    cursor = page.cursor;
  } while (cursor !== undefined);

  const traces: string[] = [];
  for (const threadId of threadIds) {
    const taskId = threadId.slice(prefix.length);
    const episode = metrics.episodes.find((e) => e.taskId === taskId);
    const result = episode
      ? `${episode.outcome} after ${episode.rounds} round(s), score ${fmt(episode.score)}` +
        (episode.hiddenPassed === false ? ", HIDDEN TESTS FAILED" : "") +
        ` (label: ${episode.label})`
      : "";
    traces.push(
      [
        `### ${taskId}: ${result}`,
        ...trailFromLog(await store.read(threadId)).map((line) => `  ${line}`),
      ].join("\n"),
    );
  }
  return traces;
}

function reflectionPrompt(
  current: AgentWorkflowConfig,
  before: SplitMetrics,
  traces: string[],
  feedback: string[],
): string {
  return [
    "## Goal",
    REVIEW_GOAL,
    "",
    "## Objective",
    OBJECTIVE_TEXT,
    "",
    "## ENVIRONMENT (read-only: the review loop; you cannot change it)",
    describeMachine(codeReviewLoopMachine),
    "",
    "## POLICY (yours to rewrite: the current triage policy)",
    describeMachine(lowerPolicy(current)),
    "",
    "### Current policy JSON",
    JSON.stringify(current, null, 2),
    "",
    "## Policy rules",
    ...RULES,
    "",
    `## Last batch (train): ${metricsLine(before.train)}`,
    ...traces,
    "",
    `## Held-out (trails withheld): objective ${fmt(before.heldOut.objective)}`,
    ...(feedback.length
      ? ["", "## Your previous proposals were rejected", ...feedback.map((f) => `- ${f}`)]
      : []),
    "",
    "Return the complete improved policy config, with a new `id`.",
  ].join("\n");
}

// ─── Gates ───

const failing = (names: string[]) => ({ passed: false, failingTests: names, output: "" });
const passing = { passed: true, failingTests: [], output: "all tests passed" };
const VISIBLE = briefOf(getTask("slugify")).visibleTestNames;

/**
 * Environment states at the triage boundary that walk every branch v1 cares
 * about: a failing visible test, a review-only flaw, a contradiction, a
 * novel issue (RETRY withheld), a crash (RETRY withheld), self-check
 * concerns only, and a failing test with an approving reviewer.
 */
export const PROBE_CONTEXTS: Array<Partial<ReviewContext>> = [
  {
    checks: failing([VISIBLE[2]!]),
    review: { approved: false, issues: [{ severity: "minor", note: "edge cases" }] },
  },
  { checks: passing, review: { approved: false, issues: [{ severity: "major", note: "bug" }] } },
  {
    checks: passing,
    review: {
      approved: false,
      issues: [{ severity: "major", note: "the spec and the tests contradict each other" }],
    },
  },
  {
    checks: failing([VISIBLE[0]!]),
    review: { approved: false, issues: [{ severity: "novel", note: "broken task" }] },
  },
  { checks: failing(["visible-tests.mjs"]), review: { approved: true, issues: [] } },
  {
    checks: failing([VISIBLE[1]!]),
    review: { approved: true, issues: [] },
    selfCheck: { ok: false, concerns: ["unsure"] },
  },
  { checks: failing([VISIBLE[1]!]), review: { approved: true, issues: [] } },
];

/** A full review context for a probe: slugify after round 1. */
export function probeContext(overrides: Partial<ReviewContext>): ReviewContext {
  return {
    task: briefOf(getTask("slugify")),
    round: 1,
    roundLimit: MAX_ROUNDS,
    patch: "",
    feedback: "",
    selfCheck: { ok: true, concerns: [] },
    review: { approved: true, issues: [] },
    checks: passing,
    escalation: "",
    humanApproved: false,
    notice: "",
    ...overrides,
  };
}

/**
 * The triage request the REAL environment builds at a probe: the decide input
 * from `triageInput`, with only the options the environment accepts there.
 */
export function triageRequestAt(context: ReviewContext): AgentExecutorDecisionRequest {
  const snapshot = codeReviewLoopMachine.resolveState({ value: "deciding", context });
  const input = triageInput(context);
  const options = Object.entries(input.payloads)
    .flatMap(([type, payloads]) =>
      payloads.map((payload) => ({ event: { ...payload, type } as ChosenEvent })),
    )
    .filter((option) => snapshot.can(option.event as never));
  return {
    kind: "decision",
    id: "triage",
    name: "triage",
    model: input.model,
    system: input.system,
    prompt: input.prompt,
    events: input.allowedEvents.map((type) => ({ type, toolName: type })),
    options,
    attempts: [],
    metadata: input.metadata,
  } as AgentExecutorDecisionRequest;
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * "outputs": the candidate at the REAL boundary. From each probe, with the
 * classifier answering both ways and an inner decide answering with its k-th
 * option, every answer must be one of the options the environment offered.
 */
async function checkOutputs(config: AgentWorkflowConfig): Promise<string[]> {
  const problems = new Set<string>();
  for (const novel of [true, false]) {
    let k = 0;
    const decide = createPolicyDecide(config, {
      classify: async () => ({ novel, confidence: 0.9 }),
      executors: {
        decide: async (request) => {
          const options = request.options ?? [];
          return {
            event: options.length
              ? options[k % options.length]!.event
              : { type: request.events[k % request.events.length]!.type },
          };
        },
      },
    });
    for (const [index, overrides] of PROBE_CONTEXTS.entries()) {
      const request = triageRequestAt(probeContext(overrides));
      for (k = 0; k < 3; k++) {
        try {
          const { event } = await decide(request);
          if (!request.options!.some((option) => isDeepStrictEqual(option.event, event))) {
            problems.add(
              `probe ${index} (novel=${novel}): ${JSON.stringify(event)} is not an offered option ` +
                `(offered: ${request.options!.map((o) => JSON.stringify(o.event)).join(", ")})`,
            );
          }
        } catch (error) {
          problems.add(`probe ${index} (novel=${novel}): ${errorMessage(error)}`);
        }
      }
    }
  }
  return [...problems];
}

/** verifyAgentConfig over the policy vocabulary, then the outputs probe. Stops at the first failure. */
async function staticGates(candidate: unknown): Promise<Gate[]> {
  const isObject = !!candidate && typeof candidate === "object" && !Array.isArray(candidate);
  const verified = await verifyAgentConfig(
    isObject ? withPolicyInterface(candidate as AgentWorkflowConfig) : candidate,
    {
      compileSchema: ajvCompileSchema,
      allow: {
        actors: [...policyActorNames],
        requests: [],
        guards: [],
        actions: [],
        events: [...POLICY_EVENTS],
        models: [POLICY_MODEL],
      },
      explore: {
        inputs: PROBE_CONTEXTS.map((overrides) =>
          policyInputOf(triageRequestAt(probeContext(overrides))),
        ),
        maxDepth: 8,
        outputs: {
          classifyIssue: [
            { novel: true, confidence: 0.9 },
            { novel: false, confidence: 0.9 },
          ],
        },
      },
    },
  );
  const gates: Gate[] = [...verified.gates];
  if (!verified.ok) return gates;
  const problems = await checkOutputs(candidate as AgentWorkflowConfig);
  gates.push(
    problems.length
      ? { name: "outputs", ok: false, detail: problems.join("\n") }
      : { name: "outputs", ok: true },
  );
  return gates;
}

// ─── The loop ───

export async function improvePolicy(options: ImproveOptions): Promise<ImprovementResult> {
  const {
    current,
    executors,
    train = TRAIN_TASKS,
    heldOut = HELD_OUT_TASKS,
    maxRepairs = 3,
    store = createInMemoryEventLogStore(),
    log = () => {},
  } = options;

  // Thread ids are `<split>/<policyVersion>/<taskId>`, so the reflection
  // lists one version's train threads only: held-out trails never reach it.
  const measure = async (config: AgentWorkflowConfig, version: string): Promise<SplitMetrics> => {
    const decide = createPolicyDecide(config, {
      classify: options.classify,
      ...(options.policyDecide ? { executors: { decide: options.policyDecide } } : {}),
    });
    const batch = async (label: string, tasks: Task[]) => {
      const metrics = await runBatch(`${version} ${label}`, tasks, {
        executors: withPolicy(executors, decide),
        runner: options.runner,
        store,
        policyVersion: version,
      });
      log(`${version} ${label.padEnd(8)} ${metricsLine(metrics)}`);
      return metrics;
    };
    const trainBatch = await batch("train", train);
    const heldOutBatch = await batch("held-out", heldOut);
    return {
      train: trainBatch,
      heldOut: heldOutBatch,
      all: summarize(version, [...trainBatch.episodes, ...heldOutBatch.episodes]),
    };
  };

  const currentVersion = current.id ?? "current";
  const before = await measure(current, currentVersion);
  const traces = await trainTraces(store, `train/${currentVersion}/`, before.train);

  const feedback: string[] = [];
  let repairs = 0;
  let proposed: AgentWorkflowConfig | undefined;
  let gates: Gate[] = [];

  for (let attempt = 0; ; attempt++) {
    const { result } = await proposePolicy.execute(
      { prompt: reflectionPrompt(current, before, traces, feedback) },
      executors,
    );
    proposed = result as unknown as AgentWorkflowConfig;
    gates = await staticGates(proposed);
    for (const gate of gates)
      log(`  gate ${gate.name}: ${gate.ok ? "pass" : `FAIL ${gate.detail ?? ""}`}`);
    const failed = gates.find((gate) => !gate.ok);
    if (!failed) break;
    if (attempt >= maxRepairs) {
      return { promoted: false, config: current, proposed, before, gates, repairs, store };
    }
    feedback.push(`gate '${failed.name}' failed: ${failed.detail ?? "(no detail)"}`);
    repairs += 1;
  }

  const candidateVersion =
    proposed.id && proposed.id !== currentVersion ? proposed.id : `${currentVersion}-candidate`;
  const after = await measure(proposed, candidateVersion);
  const reasons = [
    after.train.violations === 0 ? undefined : `${after.train.violations} violations on train`,
    after.heldOut.violations === 0
      ? undefined
      : `${after.heldOut.violations} violations on held-out`,
    after.heldOut.objective >= before.heldOut.objective
      ? undefined
      : `held-out objective fell ${fmt(before.heldOut.objective)} -> ${fmt(after.heldOut.objective)}`,
    after.all.objective > before.all.objective
      ? undefined
      : `combined objective did not rise ${fmt(before.all.objective)} -> ${fmt(after.all.objective)}`,
  ].filter((reason): reason is string => reason !== undefined);
  const promoted = reasons.length === 0;
  gates.push(
    promoted
      ? {
          name: "replay",
          ok: true,
          detail:
            `objective ${fmt(before.all.objective)} -> ${fmt(after.all.objective)} ` +
            `(held-out ${fmt(before.heldOut.objective)} -> ${fmt(after.heldOut.objective)})`,
        }
      : { name: "replay", ok: false, detail: reasons.join("; ") },
  );
  log(`  gate replay: ${promoted ? "pass" : "FAIL"} ${gates.at(-1)!.detail ?? ""}`);

  return {
    promoted,
    config: promoted ? proposed : current,
    proposed,
    before,
    after,
    gates,
    repairs,
    store,
  };
}
