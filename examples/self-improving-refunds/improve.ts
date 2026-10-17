/**
 * The self-improvement loop: the agent rewrites its own way of working (the
 * playbook JSON), never the desk.
 *
 *   run a batch with the current playbook  → before
 *   reflect: one `proposePlaybook` text request → a candidate config
 *   gates (each recorded): validate → vocabulary → lower → lint → terminates → outputs
 *     a failing gate feeds its message back as a repair prompt (≤ maxRepairs)
 *   replay: the same batch with the candidate → after
 *   promote iff no violations, accuracy no worse, and strictly cheaper
 *     (model calls + judge calls + guard rejections)
 */
import { z } from "zod";
import type { Experimental_DecisionModel } from "ai";
import {
  createDecisionRequest,
  createTextLogic,
  type AgentWorkflowConfig,
  type ChosenEvent,
} from "@statelyai/agent";
import { explorePaths, lintAgentMachine } from "@statelyai/agent/testing";
import { validateAgentConfig } from "@statelyai/agent/validate";
import type { AnyStateMachine } from "xstate";
import {
  APPROVAL_THRESHOLD,
  PROPOSALS,
  runBatch,
  SCENARIOS,
  type Arm,
  type BatchMetrics,
  type Facts,
  type Scenario,
} from "./contract.js";
import {
  createPlaybookDecide,
  lowerPlaybook,
  PLAYBOOK_DECIDE_SRC,
  PLAYBOOK_MODEL,
  playbookActorNames,
  playbookGuards,
  playbookRequestNames,
  type PlaybookDecide,
  type PlaybookExecutors,
} from "./playbook.js";

export type Gate = { name: string; ok: boolean; detail?: string };

export type ImprovementResult = {
  promoted: boolean;
  /** The playbook now in force: `proposed` when promoted, else `current`. */
  config: AgentWorkflowConfig;
  /** The last candidate the model proposed. */
  proposed?: AgentWorkflowConfig;
  before: BatchMetrics;
  /** Only set when a candidate passed every static gate and was replayed. */
  after?: BatchMetrics;
  /** The gates the last candidate went through, in order. */
  gates: Gate[];
  /** Repair prompts sent after a failed gate. */
  repairs: number;
};

export type ImproveOptions = {
  current: AgentWorkflowConfig;
  /** Builds the arm that runs a batch with a given decider (the desk, in the real loop). */
  arm: (decide: PlaybookDecide) => Arm;
  executors: PlaybookExecutors;
  judge?: Experimental_DecisionModel;
  scenarios?: Scenario[];
  maxRepairs?: number;
};

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
    "You improve the playbook a refund desk uses to pick its next step. You return a " +
    "complete playbook: a JSON agent workflow config. The desk's guards are fixed and " +
    "will refuse illegal steps; your goal is a playbook that is right on every scenario " +
    "and cheaper: fewer text-model calls, fewer judge calls, fewer refused proposals.",
  prompt: ({ input }) => input.prompt,
});

const RULES = [
  'Input is the desk\'s Facts. Keep them in context: `"context": { "facts": "{{ input }}", ... }`.',
  'End in a `type: final` state whose `output` is ONE proposal: `{ "type": <proposal>, ...payload }`, usually `"{{ context.proposal }}"`.',
  `Proposals and payloads: VERIFY_IDENTITY {}, LOOKUP_ORDER { orderId }, ASK_CUSTOMER { question }, REQUEST_APPROVAL { amount }, ISSUE_REFUND { amount }, ESCALATE { reason }, CLOSE { reason }.`,
  "Values are JSON literals or `{{ dot.path }}` templates over input/context/event. A whole-string template keeps the value's type (numbers stay numbers). Array items are paths too: `{{ context.facts.orderIdCandidates.0 }}`.",
  "Guards are `{{ path }}` (truthy test only: no comparisons, operators, or negation) or one of the named guards below. Use `type: choice` states with a first-match `choice` list; the last branch has no guard.",
  `Named guards (read context.facts): ${Object.keys(playbookGuards).join(", ")}.`,
  `Actors: classifyTicket (input { ticket, customerReplies }; onDone reads {{ event.output.isRefundRequest }}). One judge call each.`,
  `Requests: draftQuestion (input { ticket, missing }; onDone reads {{ event.output.result.question }}). One text-model call each.`,
  `agent.decide: input { name, model: "${PLAYBOOK_MODEL}", system, prompt, allowedEvents: subset of proposals }. Handle every allowed event in the state's \`on\` (assign "{{ event }}" to proposal, target the final state). No onDone on agent.decide. One text-model call each.`,
  "Give every invoke an onError. Do not declare schemas.input/events/output, requests, or actors: the host injects them. No named actions.",
].map((rule) => `- ${rule}`);

function reflectionPrompt(
  current: AgentWorkflowConfig,
  before: BatchMetrics,
  feedback: string[],
): string {
  const episodes = before.episodes.map((episode) =>
    [
      `### ${episode.scenarioId}: ${episode.outcome} (${episode.correct ? "correct" : "WRONG"}), ` +
        `${episode.modelCalls} model, ${episode.judgeCalls} judge, ${episode.rejections} rejected` +
        (episode.violations.length
          ? `, VIOLATIONS: ${episode.violations.map((v) => v.rule).join(", ")}`
          : ""),
      ...episode.trail.map((line) => `  ${line}`),
    ].join("\n"),
  );
  return [
    "## Playbook rules",
    ...RULES,
    "",
    "## Current playbook",
    JSON.stringify(current, null, 2),
    "",
    `## Last batch: accuracy ${before.accuracy}, violations ${before.violations}, ` +
      `model calls ${before.modelCalls}, judge calls ${before.judgeCalls}, rejections ${before.rejections}`,
    ...episodes,
    ...(feedback.length
      ? ["", "## Your previous proposals were rejected", ...feedback.map((f) => `- ${f}`)]
      : []),
    "",
    "Return the complete improved playbook.",
  ].join("\n");
}

// ─── Gates ───

type StateWalk = { path: string; state: Record<string, unknown> };

function walkStates(states: unknown, prefix = ""): StateWalk[] {
  if (!states || typeof states !== "object") return [];
  return Object.entries(states as Record<string, Record<string, unknown>>).flatMap(
    ([key, state]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      return [{ path, state }, ...walkStates(state?.states, path)];
    },
  );
}

type ConfigNode = Record<string, unknown>;

/** A config's `T | T[]` field as a list of objects. */
const nodes = (value: unknown): ConfigNode[] =>
  (value === undefined ? [] : Array.isArray(value) ? value : [value]) as ConfigNode[];

/** Every transition config on a state: `on`, `always`, `choice`, `after`, `onDone`, and invoke done/error. */
function transitionsOf(state: ConfigNode): ConfigNode[] {
  const invokes = nodes(state.invoke);
  return [
    ...Object.values((state.on ?? {}) as Record<string, unknown>).flatMap(nodes),
    ...Object.values((state.after ?? {}) as Record<string, unknown>).flatMap(nodes),
    ...nodes(state.always),
    ...nodes(state.choice),
    ...nodes(state.onDone),
    ...invokes.flatMap((invoke) => [...nodes(invoke.onDone), ...nodes(invoke.onError)]),
  ];
}

const hasTemplate = (value: unknown) => typeof value === "string" && value.includes("{{");

/**
 * The vocabulary gate: only the fixed actor/request names, `agent.decide`
 * over proposals with a string model, the `playbookGuards` registry, and no
 * named actions. Returns one line per problem.
 */
export function checkVocabulary(config: AgentWorkflowConfig): string[] {
  const problems: string[] = [];
  const srcs = [PLAYBOOK_DECIDE_SRC, ...playbookActorNames, ...playbookRequestNames];
  for (const key of Object.keys(config.requests ?? {})) {
    if (!(playbookRequestNames as readonly string[]).includes(key)) {
      problems.push(
        `request '${key}' is not in the vocabulary (${playbookRequestNames.join(", ")})`,
      );
    }
  }
  for (const key of Object.keys(config.actors ?? {})) {
    if (!(playbookActorNames as readonly string[]).includes(key)) {
      problems.push(`actor '${key}' is not in the vocabulary (${playbookActorNames.join(", ")})`);
    }
  }
  for (const { path, state } of walkStates(config.states)) {
    for (const invoke of nodes(state.invoke)) {
      const src = String(invoke.src);
      if (!srcs.includes(src)) {
        problems.push(`state '${path}' invokes unknown src '${src}'; allowed: ${srcs.join(", ")}`);
        continue;
      }
      if (src !== PLAYBOOK_DECIDE_SRC) continue;
      const input = (invoke.input ?? {}) as Record<string, unknown>;
      if (typeof input.model !== "string" || hasTemplate(input.model)) {
        problems.push(`state '${path}': agent.decide needs a literal string model ref`);
      }
      const allowed = input.allowedEvents;
      if (!Array.isArray(allowed) || allowed.length === 0) {
        problems.push(`state '${path}': agent.decide needs a non-empty allowedEvents list`);
      } else {
        for (const type of allowed) {
          if (!(PROPOSALS as readonly unknown[]).includes(type)) {
            problems.push(
              `state '${path}': allowedEvents entry '${String(type)}' is not a proposal`,
            );
          }
        }
      }
    }
    for (const transition of transitionsOf(state)) {
      const guard = transition.guard;
      if (typeof guard === "string" && !hasTemplate(guard) && !(guard in playbookGuards)) {
        problems.push(
          `state '${path}' uses unknown named guard '${guard}'; allowed: ${Object.keys(playbookGuards).join(", ")}`,
        );
      }
      for (const action of nodes(transition.actions)) {
        if (action.type !== undefined) {
          problems.push(`state '${path}' uses named action '${String(action.type)}'; none exist`);
        }
      }
    }
    for (const key of ["entry", "exit"] as const) {
      for (const action of nodes(state[key])) {
        if (action.type !== undefined) {
          problems.push(
            `state '${path}' ${key} uses named action '${String(action.type)}'; none exist`,
          );
        }
      }
    }
  }
  return problems;
}

/**
 * Facts that walk every branch v1 cares about, so the dry-run gates see more
 * than the happy path: unverified, identity refused, no order with and
 * without a candidate, wrong customer, refunded, small, large, approved.
 */
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

const STUB_PAYLOADS: Record<string, Record<string, unknown>> = {
  VERIFY_IDENTITY: {},
  LOOKUP_ORDER: { orderId: "ORD-1001" },
  ASK_CUSTOMER: { question: "stub?" },
  REQUEST_APPROVAL: { amount: 240 },
  ISSUE_REFUND: { amount: 40 },
  ESCALATE: { reason: "stub" },
  CLOSE: { reason: "stub" },
};

/**
 * "terminates": `explorePaths` from each probe, forking every `agent.decide`
 * over its candidates and `classifyTicket` both ways. Every terminal must be
 * `done` (no idle wait, no loop past maxDepth, no unknown src, no unhandled
 * error).
 */
async function checkTerminates(machine: AnyStateMachine): Promise<string[]> {
  const problems: string[] = [];
  for (const [index, input] of PROBE_FACTS.entries()) {
    for (const isRefundRequest of [true, false]) {
      const report = await explorePaths(machine, {
        input,
        maxDepth: 6,
        invokes: { classifyTicket: { isRefundRequest, confidence: 0.9 } },
        text: { draftQuestion: { question: "stub?" } },
      });
      for (const terminal of report.terminals) {
        if (terminal.status !== "done") {
          problems.push(
            `probe ${index} (refund=${isRefundRequest}): path [${terminal.path.map((e) => e.type).join(", ")}] ` +
              `ends '${terminal.status}' in ${JSON.stringify(terminal.state)}` +
              (terminal.missingSrc ? ` (no output for '${terminal.missingSrc}')` : ""),
          );
        }
      }
      if (report.hitPathCap) problems.push(`probe ${index}: too many paths to explore`);
    }
  }
  return problems;
}

/**
 * "outputs": runs the real decider from each probe with stub executors (each
 * decision answered by its k-th candidate, k over every proposal) and a stub
 * judge both ways. Every run must end `done` with an output that parses as a
 * proposal; `createPlaybookDecide` throws otherwise.
 */
async function checkOutputs(config: AgentWorkflowConfig): Promise<string[]> {
  const problems = new Set<string>();
  for (const isRefundRequest of [true, false]) {
    let k = 0;
    const decide = createPlaybookDecide(config, {
      executors: {
        generateText: async () => ({ result: { question: "stub?" } }),
        decide: async (request) => {
          const type = request.events[k % request.events.length]!.type;
          return { event: { type, ...STUB_PAYLOADS[type] } as ChosenEvent };
        },
      },
      judge: stubJudge(isRefundRequest),
    });
    for (const [index, input] of PROBE_FACTS.entries()) {
      for (k = 0; k < PROPOSALS.length; k++) {
        try {
          await decide({
            ...createDecisionRequest({ model: "playbook", input, events: PROPOSALS }),
            name: "probe",
          });
        } catch (error) {
          problems.add(`probe ${index} (refund=${isRefundRequest}): ${errorMessage(error)}`);
        }
      }
    }
  }
  return [...problems];
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

/** Runs the static gates in order and stops at the first failure. */
async function staticGates(candidate: unknown): Promise<Gate[]> {
  const gates: Gate[] = [];
  const record = (name: string, problems: string[]) => {
    gates.push(
      problems.length ? { name, ok: false, detail: problems.join("\n") } : { name, ok: true },
    );
    return problems.length === 0;
  };

  const validation = validateAgentConfig(candidate);
  if (
    !record(
      "validate",
      validation.errors.map(
        (e: { path: string; message: string }) => `${e.path || "(root)"} ${e.message}`,
      ),
    )
  ) {
    return gates;
  }
  const config = candidate as AgentWorkflowConfig;
  if (!record("vocabulary", checkVocabulary(config))) return gates;

  let machine: AnyStateMachine;
  try {
    machine = lowerPlaybook(config);
    record("lower", []);
  } catch (error) {
    record("lower", [errorMessage(error)]);
    return gates;
  }
  try {
    lintAgentMachine(machine, { throw: true });
    record("lint", []);
  } catch (error) {
    record("lint", [errorMessage(error)]);
    return gates;
  }
  if (!record("terminates", await checkTerminates(machine))) return gates;
  record("outputs", await checkOutputs(config));
  return gates;
}

const cost = (metrics: BatchMetrics) =>
  metrics.modelCalls + metrics.judgeCalls + metrics.rejections;

// ─── The loop ───

export async function improvePlaybook(options: ImproveOptions): Promise<ImprovementResult> {
  const { current, arm, executors, judge, scenarios = SCENARIOS, maxRepairs = 3 } = options;
  const decider = (config: AgentWorkflowConfig) =>
    createPlaybookDecide(config, { executors, judge });

  const before = await runBatch(arm(decider(current)), scenarios);

  const feedback: string[] = [];
  let repairs = 0;
  let proposed: AgentWorkflowConfig | undefined;
  let gates: Gate[] = [];

  for (let attempt = 0; ; attempt++) {
    const { result } = await proposePlaybook.execute(
      { prompt: reflectionPrompt(current, before, feedback) },
      executors,
    );
    proposed = result as unknown as AgentWorkflowConfig;
    gates = await staticGates(proposed);
    const failed = gates.find((gate) => !gate.ok);
    if (!failed) break;
    if (attempt >= maxRepairs) {
      return { promoted: false, config: current, proposed, before, gates, repairs };
    }
    feedback.push(`gate '${failed.name}' failed: ${failed.detail}`);
    repairs += 1;
  }

  const after = await runBatch(arm(decider(proposed)), scenarios);
  const reasons = [
    after.violations === 0 ? undefined : `${after.violations} violations`,
    after.accuracy >= before.accuracy
      ? undefined
      : `accuracy fell ${before.accuracy} -> ${after.accuracy}`,
    cost(after) < cost(before) ? undefined : `cost did not fall ${cost(before)} -> ${cost(after)}`,
  ].filter((reason): reason is string => reason !== undefined);
  const promoted = reasons.length === 0;
  gates.push(
    promoted
      ? {
          name: "replay",
          ok: true,
          detail: `accuracy ${before.accuracy} -> ${after.accuracy}, cost ${cost(before)} -> ${cost(after)}`,
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
  };
}
