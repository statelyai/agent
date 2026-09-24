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
 * Machine shape — each node is a request state, each edge a `choice` state:
 *
 *   checkingRelevance → relevanceGate ─┬─ checkingGrammar → grammarGate ─┬─ analyzingStructure
 *                                      └─ scoring                        └─ scoring
 *   analyzingStructure → structureGate ─┬─ evaluatingDepth → scoring
 *                                       └─ scoring
 *   (any request error) → failed
 *
 * What maps to what:
 *   - the four grading nodes → four request states, each with structured output
 *     `{ score, comment }` (the tutorial regex-parses "Score: 0.8" from prose)
 *   - the three conditional-edge lambdas → `relevanceGate`, `grammarGate`,
 *     `structureGate`: choice states over the exported *_THRESHOLD constants
 *   - calculate_final_score → the `scoring` final state's `output`
 *
 * Differences from LangGraph worth calling out:
 *   - Where grading stopped is part of the result (`stage`). The tutorial
 *     leaves skipped scores at 0.0, so "scored 0" and "never ran" look alike.
 *   - A score outside [0, 1] fails schema validation instead of being
 *     regex-parsed; a failed call lands in `failed` with the scores so far.
 *   - The weighted sum counts a skipped pass as 0, like the tutorial (no
 *     renormalization), so an early exit is also a low final score.
 *
 * No stand-ins: every node is a model call or pure arithmetic.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/essay-grader/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import { getStatePath, runAgent, setupAgent, type AgentRequestExecutors } from "@statelyai/agent";

const models = { grader: openai("gpt-5.4-mini") };

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

/** One grading request per criterion; they differ only in the rubric. */
function gradingRequest(rubric: string) {
  return {
    schemas: { input: z.object({ essay: z.string() }), output: gradeSchema },
    model: "grader" as const,
    system:
      `You grade student essays. ${rubric} Return a score between 0 and 1 ` +
      "(1 is best) and a one-sentence comment explaining it.",
    prompt: ({ input }: { input: { essay: string } }) => `Essay:\n${input.essay}`,
  };
}

const agentSetup = setupAgent({
  models,
  context: essayContextSchema,
  input: z.object({ essay: z.string() }),
  output: gradeOutputSchema,
  requests: {
    checkRelevance: gradingRequest(
      "Judge how relevant the essay is to a coherent topic it sets itself, and whether it stays on it.",
    ),
    checkGrammar: gradingRequest("Judge grammar, spelling and sentence-level language use."),
    analyzeStructure: gradingRequest(
      "Judge organization: a clear introduction, body paragraphs that build, and a conclusion.",
    ),
    evaluateDepth: gradingRequest(
      "Judge depth of analysis: critical thinking, evidence, and original insight.",
    ),
  },
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
          context: { relevance: output.result },
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
        onDone: ({ output }) => ({ target: "grammarGate", context: { grammar: output.result } }),
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
          context: { structure: output.result },
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
        onDone: ({ output }) => ({ target: "scoring", context: { depth: output.result } }),
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
  /** Injected for tests; the direct run supplies a real model executor. */
  generateText?: AgentRequestExecutors["generateText"];
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
  const { essay = SAMPLE_ESSAY, generateText, onProgress } = options;
  const progress: string[] = [];
  const result = await runAgent(essayGraderMachine, {
    input: { essay },
    ...(generateText
      ? { executors: { generateText } }
      : { executors: createAiSdkExecutors({ models }) }),
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
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  void (async () => {
    const { generateText } = createAiSdkExecutors({ models });
    const result = await runEssayGraderExample({
      generateText,
      onProgress: (state) => console.log(`  → ${state}`),
    });
    console.log(`\n${result.report}`);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
