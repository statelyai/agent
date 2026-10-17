/**
 * The self-improvement loop: the agent rewrites its POLICY (the playbook
 * JSON), never its ENVIRONMENT (the desk).
 *
 *   run train + held-out with the current playbook       → before (traces in the store)
 *   reflect: one `proposePlaybook` text request          → a candidate config
 *     the prompt: the goal, the objective, the environment and policy as
 *     `describeMachine` text, the train metrics, and each train episode's
 *     trail read back from its event-log thread
 *   gates: verifyAgentConfig (validate → vocabulary → lower → lint → explore),
 *     then `outputs` (the candidate answers the real desk boundary from probe states)
 *     a failing gate's `detail` goes back as a repair prompt (≤ maxRepairs)
 *   replay: train + held-out with the candidate         → after
 *   promote iff zero violations on both splits, the held-out objective is no
 *     worse, and the combined objective is strictly better
 */
import { z } from "zod";
import type { Experimental_DecisionModel } from "ai";
import {
  createTextLogic,
  describeMachine,
  type AgentEventLogStore,
  type AgentWorkflowConfig,
  type ChosenEvent,
} from "@statelyai/agent";
import { createInMemoryEventLogStore } from "@statelyai/agent/log";
import { verifyAgentConfig, type AgentConfigGate } from "@statelyai/agent/validate";
import {
  APPROVAL_THRESHOLD,
  HELD_OUT_SCENARIOS,
  PROPOSALS,
  runSplits,
  SCENARIOS,
  type Arm,
  type BatchMetrics,
  type Facts,
  type Scenario,
  type SplitMetrics,
} from "./contract.js";
import {
  DESK_GOAL,
  createDeskArm,
  decideDeskStep,
  deskSnapshotAt,
  readTrail,
  refundDeskMachine,
  type DeskContext,
} from "./desk.js";
import {
  ajvCompileSchema,
  createPlaybookDecide,
  lowerPlaybook,
  PLAYBOOK_MODEL,
  playbookActorNames,
  playbookGuards,
  playbookInputOf,
  playbookRequestNames,
  withPlaybookInterface,
  type PlaybookDecide,
  type PlaybookExecutors,
} from "./playbook.js";

// ─── The objective (from the goal's success criteria) ───

/** What each unit of cost takes off the objective, per episode. */
export const OBJECTIVE_WEIGHTS = { modelCall: 0.02, judgeCall: 0.01, rejection: 0.02 };

/**
 * The goal as a number: accuracy, minus a small cost per model call, judge
 * call, and rejected step (averaged per episode). Accuracy dominates: one
 * wrong ticket in eight (0.125) outweighs six model calls per ticket. Any
 * invariant violation is `-Infinity`.
 */
export function objective(metrics: BatchMetrics): number {
  if (metrics.violations > 0) return Number.NEGATIVE_INFINITY;
  const episodes = Math.max(metrics.episodes.length, 1);
  const w = OBJECTIVE_WEIGHTS;
  const cost =
    w.modelCall * metrics.modelCalls +
    w.judgeCall * metrics.judgeCalls +
    w.rejection * metrics.rejections;
  return metrics.accuracy - cost / episodes;
}

const OBJECTIVE_TEXT =
  `objective = accuracy - (${OBJECTIVE_WEIGHTS.modelCall} * model calls + ` +
  `${OBJECTIVE_WEIGHTS.judgeCall} * judge calls + ${OBJECTIVE_WEIGHTS.rejection} * rejections) / episodes; ` +
  "any invariant violation makes it -Infinity. Higher is better.";

// ─── Options and result ───

export type Gate = AgentConfigGate | { name: "outputs" | "replay"; ok: boolean; detail?: string };

/** What a batch run gets: where to journal, and a thread prefix unique to this batch. */
export type BatchRun = { store: AgentEventLogStore; threadPrefix: string };

export type ImprovementResult = {
  promoted: boolean;
  /** The playbook now in force: `proposed` when promoted, else `current`. */
  config: AgentWorkflowConfig;
  /** The last candidate the model proposed. */
  proposed?: AgentWorkflowConfig;
  before: SplitMetrics;
  /** Only set when a candidate passed every static gate and was replayed. */
  after?: SplitMetrics;
  /** The gates the last candidate went through, in order. */
  gates: Gate[];
  /** Repair prompts sent after a failed gate. */
  repairs: number;
  /** Where every batch was journaled. */
  store: AgentEventLogStore;
};

export type ImproveOptions = {
  current: AgentWorkflowConfig;
  executors: PlaybookExecutors;
  judge?: Experimental_DecisionModel;
  /** Builds the arm that runs a batch with a decider. Default: the real desk. */
  arm?: (decide: PlaybookDecide, run: BatchRun) => Arm;
  train?: Scenario[];
  heldOut?: Scenario[];
  maxRepairs?: number;
  /** Where episodes are journaled. Default: a fresh in-memory store. */
  store?: AgentEventLogStore;
  /** Prefix for this round's threads (`<runId>/before/<scenario>`). Default `'round-1'`. */
  runId?: string;
};

const deskArm = (decide: PlaybookDecide, run: BatchRun): Arm =>
  createDeskArm({
    label: decide.config.id ?? "playbook",
    name: "playbook",
    decide,
    store: run.store,
    threadPrefix: run.threadPrefix,
    // A copy: the arm diffs two readings, and `decide.counters` mutates in place.
    counters: () => ({ ...decide.counters }),
  });

// ─── Reflection ───

/** The reflection request. The mock model keys on its name. */
export const proposePlaybook = createTextLogic({
  name: "proposePlaybook",
  schemas: {
    input: z.object({ prompt: z.string() }),
    output: z.looseObject({
      initial: z.string(),
      states: z.record(z.string(), z.unknown()),
    }),
  },
  model: PLAYBOOK_MODEL,
  system:
    "You improve the POLICY a refund desk uses to pick its next step: a JSON agent workflow " +
    "config (a playbook). The ENVIRONMENT (the desk machine) is fixed: it offers only legal " +
    "steps and refuses everything else. Return a complete playbook that scores higher on the " +
    "objective: right on every ticket, with fewer model calls, judge calls, and rejections.",
  prompt: ({ input }) => input.prompt,
});

const RULES = [
  'Input is the desk\'s facts plus `payloads`, this turn\'s legal options per proposal type (an empty list when none). Keep them in context: `"context": { "facts": "{{ input }}", ... }`.',
  'End in a `type: final` state whose `output` is ONE proposal: `{ "type": <proposal>, ...payload }`, usually `"{{ context.proposal }}"`. It must equal one of the offered options exactly, or the desk refuses it.',
  `Offered payloads: VERIFY_IDENTITY {}, LOOKUP_ORDER { orderId } per order id candidate, ASK_CUSTOMER { question: "Which order number is this about?" }, REQUEST_APPROVAL and ISSUE_REFUND { amount: the order total } once an order is loaded, ESCALATE and CLOSE { reason } from a fixed list (see the environment).`,
  "Values are JSON literals or `{{ dot.path }}` templates over input/context/event. A whole-string template keeps the value's type (numbers stay numbers). Array items are paths too: `{{ context.facts.orderIdCandidates.0 }}`.",
  "Guards are `{{ path }}` (truthy test only: no comparisons, operators, or negation) or one of the named guards below. Use `type: choice` states with a first-match `choice` list; the last branch has no guard.",
  `Named guards (read context.facts): ${Object.keys(playbookGuards).join(", ")}.`,
  "Actors: classifyTicket (input { ticket, customerReplies }; onDone reads {{ event.output.isRefundRequest }}). One judge call each.",
  "Requests: draftQuestion (input { ticket, missing }; onDone reads {{ event.output.result.question }}). One text-model call each.",
  `agent.decide: input { name, model: "${PLAYBOOK_MODEL}", system, prompt, allowedEvents: subset of proposals, payloads: "{{ context.facts.payloads }}" }. Handle every allowed event in the state's \`on\` (assign "{{ event }}" to proposal, target the final state). No onDone on agent.decide. One text-model call each.`,
  "Give every invoke an onError. Do not declare schemas.input/events/output, requests, or actors: the host injects them. No named actions.",
].map((rule) => `- ${rule}`);

const fmt = (value: number) => (Number.isFinite(value) ? value.toFixed(3) : String(value));

function metricsLine(metrics: BatchMetrics): string {
  return (
    `accuracy ${metrics.accuracy}, violations ${metrics.violations}, model calls ${metrics.modelCalls}, ` +
    `judge calls ${metrics.judgeCalls}, rejections ${metrics.rejections}, objective ${fmt(objective(metrics))}`
  );
}

async function reflectionPrompt(
  current: AgentWorkflowConfig,
  before: SplitMetrics,
  store: AgentEventLogStore,
  feedback: string[],
): Promise<string> {
  const episodes: string[] = [];
  for (const episode of before.train.episodes) {
    const trail = episode.threadId ? await readTrail(store, episode.threadId) : episode.trail;
    episodes.push(
      [
        `### ${episode.scenarioId}: ${episode.outcome} (${episode.correct ? "correct" : "WRONG"}), ` +
          `${episode.modelCalls} model, ${episode.judgeCalls} judge, ${episode.rejections} rejected` +
          (episode.violations.length
            ? `, VIOLATIONS: ${episode.violations.map((v) => v.rule).join(", ")}`
            : ""),
        ...trail.map((line) => `  ${line}`),
      ].join("\n"),
    );
  }
  return [
    "## Goal",
    DESK_GOAL,
    "",
    "## Objective",
    OBJECTIVE_TEXT,
    "",
    "## ENVIRONMENT (read-only: the desk; you cannot change it)",
    describeMachine(refundDeskMachine),
    "",
    "## POLICY (yours to rewrite: the current playbook)",
    describeMachine(lowerPlaybook(current)),
    "",
    "### Current playbook JSON",
    JSON.stringify(current, null, 2),
    "",
    "## Playbook rules",
    ...RULES,
    "",
    `## Last batch (train): ${metricsLine(before.train)}`,
    ...episodes,
    "",
    `## Held-out (trails withheld): objective ${fmt(objective(before.heldOut))}`,
    ...(feedback.length
      ? ["", "## Your previous proposals were rejected", ...feedback.map((f) => `- ${f}`)]
      : []),
    "",
    "Return the complete improved playbook.",
  ].join("\n");
}

// ─── Gates ───

const ORDER = { id: "ORD-1001", customerId: "C-1", total: 40, refunded: false, item: "cable" };
const BASE: Facts = {
  ticket: "ORD-1001 arrived broken, refund please.",
  customerId: "C-1",
  identityVerified: true,
  order: ORDER,
  approved: false,
  orderIdCandidates: ["ORD-1001"],
  customerReplies: [],
  rejections: [],
  turn: 1,
  approvalThreshold: APPROVAL_THRESHOLD,
};

/**
 * Desk states that walk every branch v1 cares about, so the gates see more
 * than the happy path: unverified, identity refused, no order with and
 * without a candidate, wrong customer, refunded, small, large, approved.
 */
export const PROBE_FACTS: Facts[] = [
  { ...BASE, identityVerified: false, order: null },
  {
    ...BASE,
    identityVerified: false,
    rejections: [{ proposal: "VERIFY_IDENTITY", reason: "identity check failed" }],
  },
  { ...BASE, order: null },
  { ...BASE, order: null, orderIdCandidates: [] },
  { ...BASE, order: { ...ORDER, customerId: "C-2" } },
  { ...BASE, order: { ...ORDER, refunded: true } },
  BASE,
  { ...BASE, order: { ...ORDER, total: 240 } },
  { ...BASE, order: { ...ORDER, total: 240 }, approved: true },
];

const probeSnapshot = (facts: Facts) =>
  deskSnapshotAt({
    ...facts,
    pendingProposal: null,
    identityClaim: "",
    stopReason: "",
    notice: "",
  } satisfies DeskContext);

/** The real desk's closed choice at each probe, as the playbook's input. */
async function probeInputs(): Promise<unknown[]> {
  const inputs: unknown[] = [];
  for (const facts of PROBE_FACTS) {
    const { request } = await decideDeskStep(probeSnapshot(facts), {
      decide: async (r) => ({ event: r.options![0]!.event }),
    });
    inputs.push(playbookInputOf({ ...request, name: "probe", attempts: [] }));
  }
  return inputs;
}

function stubJudge(isRefundRequest: boolean): Experimental_DecisionModel {
  return {
    specificationVersion: "v4",
    provider: "stub",
    modelId: "stub",
    supportedQuestionTypes: ["boolean"],
    doDecide: async (options) => ({
      answers: Object.fromEntries(
        Object.keys(options.questions).map((id) => [
          id,
          { type: "boolean" as const, probability: isRefundRequest ? 0.9 : 0.1 },
        ]),
      ),
      usage: { inputTokens: 0, outputTokens: 0 },
      warnings: [],
      response: { modelId: "stub", timestamp: new Date(0) },
    }),
  } as Experimental_DecisionModel;
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * "outputs": the candidate at the REAL boundary. From each probe desk state,
 * `decideDeskStep` asks it to choose, with stub executors (each inner
 * decision answered by its k-th option) and a stub judge both ways. Every
 * call must land on an offered option; a playbook that throws, idles, or
 * proposes anything else fails here instead of in a replay.
 */
async function checkOutputs(config: AgentWorkflowConfig): Promise<string[]> {
  const problems = new Set<string>();
  for (const isRefundRequest of [true, false]) {
    let k = 0;
    const decide = createPlaybookDecide(config, {
      executors: {
        generateText: async () => ({ result: { question: "stub?" } }),
        decide: async (request) => {
          const options = request.options ?? [];
          const event: ChosenEvent = options.length
            ? options[k % options.length]!.event
            : { type: request.events[k % request.events.length]!.type };
          return { event };
        },
      },
      judge: stubJudge(isRefundRequest),
    });
    for (const [index, facts] of PROBE_FACTS.entries()) {
      for (k = 0; k < PROPOSALS.length; k++) {
        try {
          await decideDeskStep(probeSnapshot(facts), { decide, name: "probe" });
        } catch (error) {
          const attempts = (error as { attempts?: { reason: string }[] }).attempts;
          const why = attempts?.length ? attempts.at(-1)!.reason : errorMessage(error);
          problems.add(`probe ${index} (refund=${isRefundRequest}): ${why}`);
        }
      }
    }
  }
  return [...problems];
}

/** verifyAgentConfig over the playbook vocabulary, then the outputs probe. Stops at the first failure. */
async function staticGates(candidate: unknown): Promise<Gate[]> {
  const isObject = !!candidate && typeof candidate === "object" && !Array.isArray(candidate);
  const verified = await verifyAgentConfig(
    isObject ? withPlaybookInterface(candidate as AgentWorkflowConfig) : candidate,
    {
      compileSchema: ajvCompileSchema,
      guards: playbookGuards,
      allow: {
        actors: [...playbookActorNames],
        requests: [...playbookRequestNames],
        guards: Object.keys(playbookGuards),
        actions: [],
        events: [...PROPOSALS],
        models: [PLAYBOOK_MODEL],
      },
      explore: {
        inputs: await probeInputs(),
        maxDepth: 6,
        outputs: {
          classifyTicket: [
            { isRefundRequest: true, confidence: 0.9 },
            { isRefundRequest: false, confidence: 0.9 },
          ],
        },
        text: { draftQuestion: { question: "stub?" } },
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

export async function improvePlaybook(options: ImproveOptions): Promise<ImprovementResult> {
  const {
    current,
    executors,
    judge,
    arm = deskArm,
    train = SCENARIOS,
    heldOut = HELD_OUT_SCENARIOS,
    maxRepairs = 3,
    store = createInMemoryEventLogStore(),
    runId = "round-1",
  } = options;
  const measure = (config: AgentWorkflowConfig, phase: "before" | "after") =>
    runSplits(
      arm(createPlaybookDecide(config, { executors, judge }), {
        store,
        threadPrefix: `${runId}/${phase}`,
      }),
      train,
      heldOut,
    );

  const before = await measure(current, "before");

  const feedback: string[] = [];
  let repairs = 0;
  let proposed: AgentWorkflowConfig | undefined;
  let gates: Gate[] = [];

  for (let attempt = 0; ; attempt++) {
    const { result } = await proposePlaybook.execute(
      { prompt: await reflectionPrompt(current, before, store, feedback) },
      executors,
    );
    proposed = result as unknown as AgentWorkflowConfig;
    gates = await staticGates(proposed);
    const failed = gates.find((gate) => !gate.ok);
    if (!failed) break;
    if (attempt >= maxRepairs) {
      return { promoted: false, config: current, proposed, before, gates, repairs, store };
    }
    feedback.push(`gate '${failed.name}' failed: ${failed.detail ?? "(no detail)"}`);
    repairs += 1;
  }

  const after = await measure(proposed, "after");
  const [beforeHeldOut, afterHeldOut] = [objective(before.heldOut), objective(after.heldOut)];
  const [beforeAll, afterAll] = [objective(before.all), objective(after.all)];
  const reasons = [
    after.train.violations === 0 ? undefined : `${after.train.violations} violations on train`,
    after.heldOut.violations === 0
      ? undefined
      : `${after.heldOut.violations} violations on held-out`,
    afterHeldOut >= beforeHeldOut
      ? undefined
      : `held-out objective fell ${fmt(beforeHeldOut)} -> ${fmt(afterHeldOut)}`,
    afterAll > beforeAll
      ? undefined
      : `combined objective did not rise ${fmt(beforeAll)} -> ${fmt(afterAll)}`,
  ].filter((reason): reason is string => reason !== undefined);
  const promoted = reasons.length === 0;
  gates.push(
    promoted
      ? {
          name: "replay",
          ok: true,
          detail: `objective ${fmt(beforeAll)} -> ${fmt(afterAll)} (held-out ${fmt(beforeHeldOut)} -> ${fmt(afterHeldOut)})`,
        }
      : { name: "replay", ok: false, detail: reasons.join("; ") },
  );

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
