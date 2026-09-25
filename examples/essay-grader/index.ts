/**
 * Essay grader — a threshold-gated grading pipeline with early exit, ported
 * from the GenAI_Agents community LangGraph tutorial "Essay grading system".
 *
 * The idea: grade an essay in four passes (relevance, grammar, structure,
 * depth of analysis), but stop as soon as one pass scores too low to make the
 * next pass worth running. An off-topic essay is not proofread; a garbled one
 * is not analyzed for structure. Whatever ran is combined into one weighted
 * score (0.3 relevance, 0.2 grammar, 0.2 structure, 0.3 depth).
 *
 * LangGraph shape — four nodes, three conditional edges into one sink:
 *
 *   check_relevance ─(>0.5)→ check_grammar ─(>0.6)→ analyze_structure ─(>0.7)→ evaluate_depth
 *         └─(else)─┐              └─(else)─┐              └─(else)─┐              │
 *                  ▼                       ▼                       ▼              ▼
 *                               calculate_final_score → END
 *
 * Machine shape — each node is a judgment state, each edge a `choice` state:
 *
 *   checkingRelevance → relevanceGate ─┬─ checkingGrammar → grammarGate ─┬─ analyzingStructure
 *                                      └─ scoring                        └─ scoring
 *   analyzingStructure → structureGate ─┬─ evaluatingDepth → scoring
 *                                       └─ scoring
 *   (any judgment error) → failed
 *
 * What maps to what:
 *   - the four grading nodes → four Jev judgment states (see note below), each
 *     one `score` question over `{ essay }` (the tutorial regex-parses
 *     "Score: 0.8" from an LLM's prose)
 *   - the three conditional-edge lambdas → `relevanceGate`, `grammarGate`,
 *     `structureGate`: choice states over the exported *_THRESHOLD constants
 *   - calculate_final_score → the `scoring` final state's `output`
 *
 * Differences from LangGraph worth calling out:
 *   - Grading is a JUDGMENT, not a generation. Each pass asks TypeSafe System
 *     One (Jev) one `score` question whose five levels describe concrete
 *     essays, lowest to highest (`RUBRICS`). The machine maps the level to
 *     [0, 1] as `score / (levels - 1)`, so the gate thresholds and the
 *     weighted final score keep the tutorial's meaning, and the comment is the
 *     matched level's description rather than model prose. The passes stay
 *     one call per gate, in order: the point of the pipeline is that an
 *     off-topic essay is never proofread, so the later questions are not asked.
 *   - Where grading stopped is part of the result (`stage`). The tutorial
 *     leaves skipped scores at 0.0, so "scored 0" and "never ran" look alike.
 *   - A score cannot fall outside [0, 1]: it is a position on a fixed rubric,
 *     not parsed text. A failed judgment call lands in `failed` with the scores
 *     so far.
 *   - The weighted sum counts a skipped pass as 0, like the tutorial (no
 *     renormalization), so an early exit is also a low final score.
 *
 * No stand-ins: every node is a Jev judgment or pure arithmetic. No text
 * model runs at all (nothing here is generated, only graded), so the direct
 * run needs only a TypeSafe key.
 *
 * Run: TYPESAFE_API_KEY=... npx tsx examples/essay-grader/index.ts
 */
import { z } from "zod";
import {
  score,
  type ScoreQuestion,
  type ScoreResponse,
  type TypeSafeClient,
} from "@typesafe-ai/sdk";
import { createSystemOneLogic } from "@statelyai/agent/typesafe";
import { getStatePath, runAgent, setupAgent } from "@statelyai/agent";

/** Each gate passes only on a score strictly above its threshold. */
export const RELEVANCE_THRESHOLD = 0.5;
export const GRAMMAR_THRESHOLD = 0.6;
export const STRUCTURE_THRESHOLD = 0.7;
/** The tutorial's weights for the final score. They sum to 1. */
export const WEIGHTS = { relevance: 0.3, grammar: 0.2, structure: 0.2, depth: 0.3 } as const;

const gradeSchema = z.object({ score: z.number().min(0).max(1), comment: z.string() });

const essayContextSchema = z.object({
  essay: z.string(),
  // `null` means that pass never ran.
  relevance: gradeSchema.nullable(),
  grammar: gradeSchema.nullable(),
  structure: gradeSchema.nullable(),
  depth: gradeSchema.nullable(),
});

type EssayContext = z.infer<typeof essayContextSchema>;
type Criterion = keyof typeof WEIGHTS;
const CRITERIA: Criterion[] = ["relevance", "grammar", "structure", "depth"];

type Rubric = { instructions: string; levels: readonly [string, string, ...string[]] };

/**
 * One Jev `score` rubric per pass. Levels describe concrete essays, lowest to
 * highest; a level index maps to [0, 1] as `index / (levels - 1)`.
 */
export const RUBRICS: Record<Criterion, Rubric> = {
  relevance: {
    instructions: "How well does `essay` stay on one coherent topic that it sets itself?",
    levels: [
      "No identifiable topic: unrelated remarks, or sentences that do not connect to each other.",
      "Names a topic, but most sentences wander to unrelated matters.",
      "Has a topic, but a substantial part of the essay drifts away from it.",
      "Stays on its topic apart from a brief aside.",
      "Every sentence serves one clearly stated topic.",
    ],
  },
  grammar: {
    instructions: "How correct are the grammar, spelling and sentence-level language of `essay`?",
    levels: [
      "Errors in most sentences make the meaning hard to follow.",
      "Frequent errors (agreement, tense, spelling, capitals) in many sentences; the meaning survives.",
      "Several noticeable errors, but most sentences are correct.",
      "One or two minor slips; otherwise correct.",
      "No grammar, spelling or punctuation errors.",
    ],
  },
  structure: {
    instructions: "How well is `essay` organized from opening to close?",
    levels: [
      "No organization: a run of unrelated statements.",
      "Points appear in no clear order, with no introduction or conclusion.",
      "An opening claim and some supporting points, but they do not build and nothing concludes.",
      "An introduction, supporting points and a conclusion, though the progression is uneven.",
      "A clear introduction, points that build on one another, and a conclusion that follows from them.",
    ],
  },
  depth: {
    instructions: "How deep is the analysis in `essay`?",
    levels: [
      "States opinions with no reasons.",
      "Gives reasons, but they are generic or asserted without evidence.",
      "Supports its claims with some specific evidence or examples.",
      "Supports its claims with evidence and engages with a counterargument.",
      "Well-evidenced claims, answers counterarguments, and offers an original insight.",
    ],
  },
};

/**
 * One grading pass as a System One judgment: the essay is the state, and the
 * pass's rubric is one `score` question named after the criterion. `client` is
 * injected by tests and hosts; omitted, the SDK reads `TYPESAFE_API_KEY`.
 */
export function createGrader<C extends Criterion>(criterion: C, client?: TypeSafeClient) {
  const rubric = RUBRICS[criterion];
  return createSystemOneLogic({
    client,
    state: (input: { essay: string }) => ({ essay: input.essay }),
    questions: () =>
      ({ [criterion]: score(rubric.instructions, rubric.levels) }) as Record<C, ScoreQuestion>,
  });
}

/** The four passes' actors, all over one (optional) client. */
function graderActors(client?: TypeSafeClient) {
  return {
    checkRelevance: createGrader("relevance", client),
    checkGrammar: createGrader("grammar", client),
    analyzeStructure: createGrader("structure", client),
    evaluateDepth: createGrader("depth", client),
  };
}

/** A rubric answer as `{ score, comment }`: the level on [0, 1] and the matched level's text. */
function toGrade(answer: ScoreResponse): z.infer<typeof gradeSchema> {
  const top = Object.keys(answer.legend).length - 1;
  return {
    score: answer.score / top,
    comment: String(answer.legend[Math.round(answer.score)]),
  };
}

/** Weighted sum over the passes that ran; a skipped pass counts as 0, as in the tutorial. */
function weightedScore(context: EssayContext): number {
  const total = CRITERIA.reduce(
    (sum, criterion) => sum + (context[criterion]?.score ?? 0) * WEIGHTS[criterion],
    0,
  );
  return Math.round(total * 1000) / 1000;
}

/** "stopped after relevance", …, or "all four stages ran" — from which scores exist. */
function stageOf(context: EssayContext): string {
  const ran = CRITERIA.filter((criterion) => context[criterion] !== null);
  if (ran.length === CRITERIA.length) return "all four stages ran";
  if (ran.length === 0) return "no stage completed";
  return `stopped after ${ran.at(-1)}`;
}

function renderReport(context: EssayContext, headline: string): string {
  const lines = CRITERIA.map((criterion) => {
    const grade = context[criterion];
    if (!grade) return `- ${criterion}: not graded`;
    return `- ${criterion} ${grade.score.toFixed(2)} (weight ${WEIGHTS[criterion]}): ${grade.comment}`;
  });
  return [headline, ...lines].join("\n");
}

const gradeOutputSchema = z.object({
  report: z.string(),
  finalScore: z.number(),
  stage: z.string(),
  // Keyed by criterion; `null` for a pass that never ran.
  scores: z.record(z.string(), z.number().nullable()),
});

function gradeOutput(context: EssayContext, verdict: string) {
  const headline = `${verdict} ${weightedScore(context)} (${stageOf(context)}).`;
  return {
    report: renderReport(context, headline),
    finalScore: weightedScore(context),
    stage: stageOf(context),
    scores: Object.fromEntries(CRITERIA.map((key) => [key, context[key]?.score ?? null])),
  };
}

const agentSetup = setupAgent({
  context: essayContextSchema,
  input: z.object({ essay: z.string() }),
  output: gradeOutputSchema,
  // Each grading pass is a Jev judgment (see createGrader).
  actors: graderActors(),
});

export const essayGraderSchemas = agentSetup.schemas;

export const essayGraderMachine = agentSetup.createMachine({
  id: "essay-grader",
  context: ({ input }) => ({
    essay: input.essay,
    relevance: null,
    grammar: null,
    structure: null,
    depth: null,
  }),
  initial: "checkingRelevance",
  states: {
    checkingRelevance: {
      invoke: {
        src: "checkRelevance",
        input: ({ context }) => ({ essay: context.essay }),
        onDone: ({ output }) => ({
          target: "relevanceGate",
          context: { relevance: toGrade(output.answers.relevance) },
        }),
        onError: { target: "failed" },
      },
    },
    // Off-topic essays are not proofread.
    relevanceGate: {
      type: "choice",
      choice: ({ context }) =>
        (context.relevance?.score ?? 0) > RELEVANCE_THRESHOLD
          ? { target: "checkingGrammar" }
          : { target: "scoring" },
    },
    checkingGrammar: {
      invoke: {
        src: "checkGrammar",
        input: ({ context }) => ({ essay: context.essay }),
        onDone: ({ output }) => ({
          target: "grammarGate",
          context: { grammar: toGrade(output.answers.grammar) },
        }),
        onError: { target: "failed" },
      },
    },
    grammarGate: {
      type: "choice",
      choice: ({ context }) =>
        (context.grammar?.score ?? 0) > GRAMMAR_THRESHOLD
          ? { target: "analyzingStructure" }
          : { target: "scoring" },
    },
    analyzingStructure: {
      invoke: {
        src: "analyzeStructure",
        input: ({ context }) => ({ essay: context.essay }),
        onDone: ({ output }) => ({
          target: "structureGate",
          context: { structure: toGrade(output.answers.structure) },
        }),
        onError: { target: "failed" },
      },
    },
    structureGate: {
      type: "choice",
      choice: ({ context }) =>
        (context.structure?.score ?? 0) > STRUCTURE_THRESHOLD
          ? { target: "evaluatingDepth" }
          : { target: "scoring" },
    },
    evaluatingDepth: {
      invoke: {
        src: "evaluateDepth",
        input: ({ context }) => ({ essay: context.essay }),
        onDone: ({ output }) => ({
          target: "scoring",
          context: { depth: toGrade(output.answers.depth) },
        }),
        onError: { target: "failed" },
      },
    },
    // calculate_final_score: reached from every gate and from the last pass.
    scoring: {
      type: "final",
      output: ({ context }) => gradeOutput(context, "Final score"),
    },
    // A grading call failed: report what was graded before it.
    failed: {
      type: "final",
      output: ({ context }) => gradeOutput(context, "Grading failed; partial score"),
    },
  },
});

export interface RunEssayGraderOptions {
  essay?: string;
  /** Injected for tests; the direct run lets the SDK read `TYPESAFE_API_KEY`. */
  jevClient?: TypeSafeClient;
  onProgress?: (state: string) => void;
}

/** `finalState` is `scoring`, or `failed` when a grading call failed. */
export type EssayGraderResult = z.infer<typeof gradeOutputSchema> & {
  finalState: string;
  progress: string[];
};

export const SAMPLE_ESSAY =
  "Public libraries remain essential in the digital age. Search engines put facts at everyone's " +
  "fingertips, but libraries offer curated knowledge, quiet space, and free access for people " +
  "with no internet at home. Librarians teach patrons to judge sources, and libraries host job " +
  "workshops and language classes. The library has become where the internet becomes useful.";

/** Runs the grading pipeline; records state progress so each early exit is observable. */
export async function runEssayGraderExample(
  options: RunEssayGraderOptions = {},
): Promise<EssayGraderResult> {
  const { essay = SAMPLE_ESSAY, jevClient, onProgress } = options;
  const progress: string[] = [];
  const result = await runAgent(essayGraderMachine, {
    input: { essay },
    ...(jevClient ? { actors: graderActors(jevClient) } : {}),
    onTransition: (snapshot) => {
      const state = getStatePath(snapshot);
      progress.push(state);
      onProgress?.(state);
    },
  });

  if (result.status !== "done") {
    throw new Error(`Essay grader example did not complete: ${result.status}`);
  }
  return { ...result.output, finalState: getStatePath(result.snapshot), progress };
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.TYPESAFE_API_KEY) {
    console.error("Set TYPESAFE_API_KEY to run this example.");
    process.exit(1);
  }
  void (async () => {
    const result = await runEssayGraderExample({
      onProgress: (state) => console.log(`  → ${state}`),
    });
    console.log(`\n${result.report}`);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
