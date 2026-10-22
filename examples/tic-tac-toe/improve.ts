/**
 * The hill climb: the agent rewrites its POLICY (the JSON strategy), never
 * its ENVIRONMENT (the game).
 *
 * One round:
 *   evaluate the current policy                       → proof, losing lines, seeded match (traces in the store)
 *   reflect: one `proposePolicy` text request         → a candidate config
 *     the prompt: the goal, the objective, the game and the policy as
 *     `describeMachine` text, the feature vocabulary, the proof's shortest
 *     losing game and other losing lines, and the match's lost games read
 *     back from the store (`listThreads`)
 *   gates: verifyAgentConfig (validate → vocabulary → lower → lint → explore),
 *     then `features` (every template reads a known feature) and `moves`
 *     (the policy plays a legal move on every board the proof visits);
 *     a failing gate's `detail` goes back as a repair prompt (≤ maxRepairs)
 *   evaluate the candidate                            → objective
 *   promote iff the objective is strictly higher
 *
 * `rounds` runs that up to N times and stops at the first round without a
 * promotion.
 */
import { z } from "zod";
import {
  createTextLogic,
  describeMachine,
  type AgentEventLogStore,
  type AgentRequestExecutor,
  type AgentWorkflowConfig,
} from "@statelyai/agent";
import { createInMemoryEventLogStore } from "@statelyai/agent/log";
import { verifyAgentConfig, type VerifyAgentConfigResult } from "@statelyai/agent/validate";
import { boardFeatures, FEATURE_NAMES, FEATURES } from "./features.js";
import { EMPTY_BOARD, GAME_GOAL, ticTacToeMachine, type Board } from "./game.js";
import { playMatch, trailFromLog, type MatchResult } from "./play.js";
import {
  ajvCompileSchema,
  createPolicyDecide,
  lowerPolicy,
  withPolicyInterface,
} from "./policy.js";
import {
  countLosingLines,
  formatGame,
  provePolicy,
  type LosingLines,
  type ProofResult,
} from "./proof.js";

// ─── The objective ───

/** What each term is worth. A losing line costs 1; the rest stays under 1 in total, so losing lines dominate. */
export const OBJECTIVE_WEIGHTS = { winRate: 0.5, state: 0.001 };

/** Everything the objective reads about one policy. */
export type Evaluation = {
  proof: ProofResult;
  losingLines: LosingLines;
  match: MatchResult;
  /** States in the policy config: its size. */
  size: number;
};

/**
 * The goal as a number, lexicographic in three tiers:
 *
 *   1. Never losing. A policy that plays an illegal move, or loses once a
 *      never-losing policy is in force (`neverLoseRequired`), is `-Infinity`:
 *      a hard constraint, never traded for wins. Before any policy has
 *      achieved it, a losing policy scores `-(losing lines)`: the distinct X
 *      move sequences that beat it, from the full game tree. That count
 *      falls as each rule lands (v0 429, +win 329, +block 67, ... 0), so the
 *      climb has a gradient where a bare proof verdict would be flat.
 *   2. Wins: `0.5 *` the win rate over the seeded random and greedy games
 *      (the perfect opponent can only be drawn).
 *   3. Size: `0.001 *` the policy's state count, a tie-breaker for simpler rules.
 *
 * Tiers 2 and 3 together stay inside (-0.05, 0.5], so one losing line
 * (a cost of 1) always outweighs any number of wins.
 */
export function objective(evaluation: Evaluation, options: { neverLoseRequired?: boolean } = {}) {
  const { proof, losingLines, match, size } = evaluation;
  if (proof.illegal.length || losingLines.illegal.length) return Number.NEGATIVE_INFINITY;
  if (match.games.some((game) => game.forfeit)) return Number.NEGATIVE_INFINITY;
  const loses = !proof.neverLoses || losingLines.count > 0 || match.byOpponent.perfect.losses > 0;
  if (loses && options.neverLoseRequired) return Number.NEGATIVE_INFINITY;
  const scored = [match.byOpponent.random, match.byOpponent.greedy];
  const games = scored.reduce((n, t) => n + t.wins + t.draws + t.losses, 0);
  const winRate = games ? scored.reduce((n, t) => n + t.wins, 0) / games : 0;
  const base = OBJECTIVE_WEIGHTS.winRate * winRate - OBJECTIVE_WEIGHTS.state * size;
  return loses ? base - losingLines.count : base;
}

const OBJECTIVE_TEXT =
  "objective = -(losing lines) + 0.5 * win rate vs random and greedy - 0.001 * states. " +
  "A losing line is one X move sequence that beats the policy (the proof enumerates every one). " +
  "Any illegal move is -Infinity, and once a never-losing policy is in force, any loss is -Infinity. " +
  "Higher is better.";

/** Plays, proves, and counts one policy; the match is journaled under `threadPrefix`. */
export async function evaluatePolicy(
  config: AgentWorkflowConfig,
  options: { store: AgentEventLogStore; threadPrefix: string },
): Promise<Evaluation> {
  const decide = createPolicyDecide(config);
  const [proof, losingLines] = [
    await provePolicy(decide.machine),
    await countLosingLines(decide.machine),
  ];
  const match = await playMatch({
    label: config.id ?? "policy",
    decide,
    store: options.store,
    threadPrefix: options.threadPrefix,
  });
  return { proof, losingLines, match, size: Object.keys(config.states ?? {}).length };
}

// ─── Reflection ───

/** The reflection request. Mock models key on its name. */
export const proposePolicy = createTextLogic({
  name: "proposePolicy",
  schemas: {
    input: z.object({ prompt: z.string() }),
    output: z.looseObject({ initial: z.string(), states: z.record(z.string(), z.unknown()) }),
  },
  model: "openai/gpt-6-luna",
  system:
    "You improve the POLICY that plays O in tic-tac-toe: a JSON agent workflow config. The " +
    "ENVIRONMENT (the game machine) is fixed: it offers only empty cells and refuses everything " +
    "else. Return a complete policy that scores higher on the objective.",
  prompt: ({ input }) => input.prompt,
});

const RULES = [
  'Input is the board features below. Keep them in context: `"context": { "facts": "{{ input }}" }`.',
  'End in a `type: final` state whose `output` is ONE move: `{ "type": "O.play", "cell": <0-8> }`, usually `"{{ context.facts.<feature>.0 }}"`. The cell must be empty.',
  "Use a `type: choice` state with a first-match `choice` list; the last branch has no guard.",
  "Guards are `{{ path }}` truthy tests only (no comparisons, operators, or negation). `{{ context.facts.<feature>.length }}` is truthy when the list is non-empty.",
  "Templates may read only `input`, `context.facts`, and `context.facts.<feature>` with an optional `.length` or `.<index>`.",
  "No invokes, model calls, named guards, or named actions: the policy must decide on its own, synchronously. Do not declare `schemas`: the host injects them.",
].map((rule) => `- ${rule}`);

const fmt = (value: number) => (Number.isFinite(value) ? value.toFixed(3) : String(value));

/** One line per opponent: `random: 20 games, 10 W / 0 D / 10 L`. */
function matchLines(match: MatchResult): string[] {
  return Object.entries(match.byOpponent).map(
    ([opponent, t]) => `- ${opponent}: ${t.wins} W / ${t.draws} D / ${t.losses} L`,
  );
}

/** The current policy's lost games, read back from the store: every thread under `prefix`. */
async function lostGames(store: AgentEventLogStore, prefix: string, match: MatchResult, keep = 5) {
  if (!store.listThreads) throw new Error("improvePolicy: the store must implement listThreads.");
  const threadIds: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.listThreads({ prefix, ...(cursor ? { cursor } : {}) });
    threadIds.push(...page.threadIds);
    cursor = page.cursor;
  } while (cursor !== undefined);
  const lost = new Set(match.games.filter((g) => g.outcome === "loss").map((g) => g.threadId));
  const games: string[] = [];
  for (const threadId of threadIds) {
    if (!lost.has(threadId) || games.length >= keep) continue;
    games.push(
      `- ${threadId.slice(prefix.length)}: ${trailFromLog(await store.read(threadId)).join(", ")}`,
    );
  }
  return games;
}

function reflectionPrompt(
  current: AgentWorkflowConfig,
  evaluation: Evaluation,
  score: number,
  traces: string[],
  feedback: string[],
): string {
  const { proof, losingLines } = evaluation;
  const verdict = proof.neverLoses
    ? `PROVEN: no X move sequence beats this policy (complete search, ${Math.round(proof.ms)}ms).`
    : proof.witnessText
      ? `REFUTED: shortest losing game ${proof.witnessText}`
      : `NOT PROVEN: ${proof.illegal.map((i) => i.problem).join("; ") || "search incomplete"}`;
  return [
    "## Goal",
    GAME_GOAL,
    "",
    "## Objective",
    OBJECTIVE_TEXT,
    "",
    "## ENVIRONMENT (read-only: the game; you cannot change it)",
    describeMachine(ticTacToeMachine),
    "",
    "## POLICY (yours to rewrite: the current policy)",
    describeMachine(lowerPolicy(current)),
    "",
    "### Current policy JSON",
    JSON.stringify(current, null, 2),
    "",
    "## Feature vocabulary (sorted cell lists, cells 0 1 2 / 3 4 5 / 6 7 8)",
    ...FEATURE_NAMES.map((name) => `- ${name}: ${FEATURES[name]}`),
    "",
    "## Policy rules",
    ...RULES,
    "",
    `## Current evaluation: objective ${fmt(score)}`,
    `Proof: ${verdict}`,
    `Losing lines: ${losingLines.count}`,
    ...losingLines.examples.map((line) => `- ${formatGame(line)}`),
    "Seeded match:",
    ...matchLines(evaluation.match),
    ...(traces.length ? ["Lost games (from the event log):", ...traces] : []),
    ...(feedback.length
      ? ["", "## Your previous proposals were rejected", ...feedback.map((f) => `- ${f}`)]
      : []),
    "",
    "Return the complete improved policy.",
  ].join("\n");
}

// ─── Gates ───

export type Gate =
  | VerifyAgentConfigResult["gates"][number]
  | { name: "features" | "moves" | "objective"; ok: boolean; detail?: string };

/** Boards for the `explore` gate: empty, after each opening, and mid-game positions with threats on both sides. */
const PROBE_BOARDS: Board[] = [
  EMPTY_BOARD,
  ["X", null, null, null, null, null, null, null, null],
  [null, null, null, null, "X", null, null, null, null],
  [null, "X", null, null, null, null, null, null, null],
  ["X", null, null, null, "O", null, null, null, "X"],
  ["X", "X", null, null, "O", null, null, null, null],
  ["X", "X", null, "O", "O", null, null, null, "X"],
  ["X", "O", "X", "O", "X", null, null, null, "O"],
];

const TEMPLATE = /\{\{\s*([\s\S]*?)\s*\}\}/g;

/** Every `{{ path }}` in the config that is not `input`, `context.facts`, or a known feature (`.length` / `.<index>`). */
export function unknownFeaturePaths(config: unknown): string[] {
  const bad = new Set<string>();
  const visit = (value: unknown) => {
    if (typeof value === "string") {
      for (const [, path] of value.matchAll(TEMPLATE)) {
        const parts = path!.split(".");
        const ok =
          path === "input" ||
          path === "context.facts" ||
          (parts[0] === "context" &&
            parts[1] === "facts" &&
            (FEATURE_NAMES as string[]).includes(parts[2] ?? "") &&
            parts.length <= 4 &&
            (parts[3] === undefined || parts[3] === "length" || /^\d$/.test(parts[3])));
        if (!ok) bad.add(path!);
      }
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  visit(config);
  return [...bad];
}

/** verifyAgentConfig with an empty vocabulary (no model calls), then the feature paths, then legal moves. */
export async function policyGates(candidate: unknown): Promise<Gate[]> {
  const isObject = !!candidate && typeof candidate === "object" && !Array.isArray(candidate);
  const verified = await verifyAgentConfig(
    isObject ? withPolicyInterface(candidate as AgentWorkflowConfig) : candidate,
    {
      compileSchema: ajvCompileSchema,
      allow: { actors: [], requests: [], guards: [], actions: [], events: [], models: [] },
      explore: { inputs: PROBE_BOARDS.map((board) => boardFeatures(board)), maxDepth: 2 },
    },
  );
  const gates: Gate[] = [...verified.gates];
  if (!verified.ok) return gates;

  const unknown = unknownFeaturePaths(candidate);
  gates.push(
    unknown.length
      ? {
          name: "features",
          ok: false,
          detail: `unknown template paths: ${unknown.join(", ")}; features: ${FEATURE_NAMES.join(", ")}`,
        }
      : { name: "features", ok: true },
  );
  if (unknown.length) return gates;

  const proof = await provePolicy(lowerPolicy(candidate as AgentWorkflowConfig));
  const illegal = proof.illegal.slice(0, 3);
  gates.push(
    illegal.length
      ? {
          name: "moves",
          ok: false,
          detail: illegal
            .map((i) => `on board ${JSON.stringify(i.board)}: ${i.problem}`)
            .join("\n"),
        }
      : { name: "moves", ok: true },
  );
  return gates;
}

// ─── The loop ───

export type RoundResult = {
  round: number;
  promoted: boolean;
  /** The policy reflected on, and its evaluation. */
  current: AgentWorkflowConfig;
  evaluation: Evaluation;
  objective: number;
  /** The last candidate proposed, and (when it passed every gate) its evaluation. */
  proposed?: AgentWorkflowConfig;
  candidate?: { evaluation: Evaluation; objective: number };
  gates: Gate[];
  repairs: number;
};

export type ImprovementResult = {
  /** The policy in force after the last round. */
  config: AgentWorkflowConfig;
  rounds: RoundResult[];
  store: AgentEventLogStore;
};

export type ImproveOptions = {
  current: AgentWorkflowConfig;
  /** Answers the `proposePolicy` request. */
  executors: { generateText: AgentRequestExecutor };
  /** Rounds to run; stops at the first round without a promotion. Default 1. */
  rounds?: number;
  maxRepairs?: number;
  /** Where every match is journaled. Default: a fresh in-memory store. */
  store?: AgentEventLogStore;
};

/** Hill-climbs the policy for up to `rounds` rounds. Threads: `round-<n>/<opponent>/<game>` (current), `round-<n>/candidate/<opponent>/<game>`. */
export async function improvePolicy(options: ImproveOptions): Promise<ImprovementResult> {
  const { executors, rounds = 1, maxRepairs = 2 } = options;
  const store = options.store ?? createInMemoryEventLogStore();
  const results: RoundResult[] = [];
  let current = options.current;

  for (let round = 1; round <= rounds; round++) {
    const prefix = `round-${round}/`;
    const evaluation = await evaluatePolicy(current, { store, threadPrefix: `round-${round}` });
    const neverLoseRequired = evaluation.proof.neverLoses;
    const score = objective(evaluation, { neverLoseRequired });
    const traces = await lostGames(store, prefix, evaluation.match);

    const feedback: string[] = [];
    let repairs = 0;
    let proposed: AgentWorkflowConfig | undefined;
    let gates: Gate[] = [];
    for (let attempt = 0; ; attempt++) {
      const { result } = await proposePolicy.execute(
        { prompt: reflectionPrompt(current, evaluation, score, traces, feedback) },
        executors,
      );
      proposed = result as unknown as AgentWorkflowConfig;
      gates = await policyGates(proposed);
      const failed = gates.find((gate) => !gate.ok);
      if (!failed) break;
      if (attempt >= maxRepairs) break;
      feedback.push(`gate '${failed.name}' failed: ${failed.detail ?? "(no detail)"}`);
      repairs += 1;
    }

    const base = { round, current, evaluation, objective: score, proposed, repairs };
    if (gates.some((gate) => !gate.ok)) {
      results.push({ ...base, promoted: false, gates });
      break;
    }
    const candidateEvaluation = await evaluatePolicy(proposed!, {
      store,
      threadPrefix: `round-${round}/candidate`,
    });
    const candidateScore = objective(candidateEvaluation, { neverLoseRequired });
    const promoted = candidateScore > score;
    gates.push({
      name: "objective",
      ok: promoted,
      detail: `objective ${fmt(score)} -> ${fmt(candidateScore)}${promoted ? "" : " (not strictly higher)"}`,
    });
    results.push({
      ...base,
      promoted,
      candidate: { evaluation: candidateEvaluation, objective: candidateScore },
      gates,
    });
    if (!promoted) break;
    current = proposed!;
  }
  return { config: current, rounds: results, store };
}
