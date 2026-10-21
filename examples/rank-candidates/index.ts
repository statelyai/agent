/**
 * Rank candidates — score every candidate against a brief, drop the weak
 * ones, drop near-duplicates, keep at most a few per bucket, and return the
 * top k with a reason for every candidate that was cut.
 *
 * The teaching point: Jev decides, code sorts. Jev only answers typed
 * questions about fuzzy things (how well does this fit the brief; would these
 * two give the audience the same thing). Thresholds, sorting, pairing, quotas
 * and the cut-off are exact work, so they are code.
 *
 * Machine shape:
 *
 *   scoring ──→ shortlisting ─┬─ deduping ──→ ranking ──→ done
 *      │                      └─ ranking (fewer than two considered: no pairs)
 *      └─ (any judgment error) → failed  ←─ deduping
 *
 * What each state does:
 *   - `scoring`: one `experimental_decide` call per candidate, one `score`
 *     question `fit` with four levels over `{ brief, candidate }`; the
 *     expected level is the score. Calls run at most `MAX_CONCURRENCY` at a
 *     time.
 *   - `shortlisting`: a choice state running `shortlist()`: filter by
 *     `minScore`, sort best first (earlier wins a tie), keep the best
 *     `consider`, pair them up.
 *   - `deduping`: one boolean `same` judgment per pair over `{ keep, other }`,
 *     kept at probability >= `SAME_THRESHOLD`.
 *   - `ranking`: a choice state running `rank()`: walk best first, cut for a
 *     chosen better twin, a full list (`top`) or a full bucket (`perBucket`).
 *
 * Worth calling out:
 *   - The numeric knobs have defaults (`DEFAULTS`), so a brief and a list are
 *     enough to run it.
 *   - The output leads with a readable `summary`, then `ranked` and `cut`.
 *   - A failed judgment lands in `failed` with the error and whatever was
 *     scored so far.
 *
 * No stand-ins and no text model: every judgment is Jev, everything else is
 * pure code, so the direct run needs only a TypeSafe key.
 *
 * Run: TYPESAFE_AI_API_KEY=... npx tsx examples/rank-candidates/index.ts
 */
import { z } from "zod";
import { createAsyncLogic } from "xstate";
import { experimental_decide, type Experimental_DecisionModel } from "ai";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import { getStatePath, runAgent, setupAgent } from "@statelyai/agent";

/**
 * The judge: TypeSafe's Jev through the AI SDK's decision-model provider.
 * Reads `TYPESAFE_AI_API_KEY`. Tests pass a mock decision model instead.
 */
const judgeModel: Experimental_DecisionModel = typeSafeAi.decisionModel("jev-latest");

/** Most decide calls in flight at once, per phase. */
export const MAX_CONCURRENCY = 4;
/** A pair counts as the same thing at or above this probability. */
export const SAME_THRESHOLD = 0.8;
/** Knobs used when the input leaves them out. `minScore` is on the 0–3 fit scale. */
export const DEFAULTS = { top: 5, consider: 8, perBucket: 2, minScore: 1.5 } as const;

/** The `fit` levels, lowest to highest; the score is the expected level (0–3). */
export const FIT_LEVELS = [
  "Unrelated to the brief.",
  "Touches the brief but would not serve it.",
  "Serves part of the brief.",
  "Serves the brief directly.",
] as const;

const candidateSchema = z.object({
  id: z.string(),
  title: z.string(),
  bucket: z.string(),
  summary: z.string(),
});
export type Candidate = z.infer<typeof candidateSchema>;

const inputSchema = z.object({
  brief: z.string(),
  candidates: z.array(candidateSchema),
  top: z.number().int().min(1).optional(),
  consider: z.number().int().min(1).optional(),
  perBucket: z.number().int().min(1).optional(),
  minScore: z.number().min(0).max(3).optional(),
});

const scoredSchema = z.object({ candidate: candidateSchema, index: z.number(), score: z.number() });
type Scored = z.infer<typeof scoredSchema>;
const cutSchema = z.object({ id: z.string(), reason: z.string() });
type Cut = z.infer<typeof cutSchema>;
const rankedSchema = z.object({
  id: z.string(),
  title: z.string(),
  bucket: z.string(),
  score: z.number(),
});
type Ranked = z.infer<typeof rankedSchema>;

const contextSchema = z.object({
  brief: z.string(),
  candidates: z.array(candidateSchema),
  top: z.number(),
  consider: z.number(),
  perBucket: z.number(),
  minScore: z.number(),
  // Aligned with `candidates`.
  scores: z.array(z.number()),
  // Best first.
  considered: z.array(scoredSchema),
  // Positions in `considered`, better first.
  pairs: z.array(z.tuple([z.number(), z.number()])),
  // Pairs judged the same.
  duplicates: z.array(z.tuple([z.number(), z.number()])),
  ranked: z.array(rankedSchema),
  cut: z.array(cutSchema),
  failure: z.string().nullable(),
});
type RankContext = z.infer<typeof contextSchema>;

/** Maps `items` through `fn`, at most `limit` calls in flight; results keep input order. */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** `scoring`: one `fit` score per candidate, aligned with the input list. */
export function createScoreCandidates(model: Experimental_DecisionModel = judgeModel) {
  return createAsyncLogic<{ scores: number[] }, { brief: string; candidates: Candidate[] }>({
    run: async ({ input, signal }) => {
      const scores = await mapBounded(input.candidates, MAX_CONCURRENCY, async (candidate) => {
        const { answers } = await experimental_decide({
          model,
          state: { brief: input.brief, candidate },
          questions: {
            fit: {
              type: "score",
              instructions: "How well does `candidate` serve `brief`?",
              criteria: FIT_LEVELS,
            },
          },
          abortSignal: signal,
        });
        return answers.fit.score;
      });
      return { scores };
    },
  });
}

/** `deduping`: one `same` probability per pair, aligned with the pairs. */
export function createFindDuplicates(model: Experimental_DecisionModel = judgeModel) {
  return createAsyncLogic<{ same: number[] }, { pairs: { keep: Candidate; other: Candidate }[] }>({
    run: async ({ input, signal }) => {
      const same = await mapBounded(input.pairs, MAX_CONCURRENCY, async (pair) => {
        const { answers } = await experimental_decide({
          model,
          state: pair,
          questions: {
            same: {
              type: "boolean",
              instructions:
                "Would `keep` and `other` give the audience the same thing, so that only one is needed?",
            },
          },
          abortSignal: signal,
        });
        return answers.same.probability;
      });
      return { same };
    },
  });
}

function rankActors(model?: Experimental_DecisionModel) {
  return {
    scoreCandidates: createScoreCandidates(model),
    findDuplicates: createFindDuplicates(model),
  };
}

/**
 * Keep candidates at or above `minScore`, best first (earlier wins a tie).
 * The best `consider` can make the list and are paired for the duplicate
 * check; the rest are cut with a reason. Tracked by position, so a repeated
 * id cannot mix two candidates up.
 */
export function shortlist(context: RankContext) {
  const scored: Scored[] = context.candidates.map((candidate, index) => ({
    candidate,
    index,
    score: context.scores[index]!,
  }));
  const pool = scored
    .filter((c) => c.score >= context.minScore)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const considered = pool.slice(0, context.consider);
  const cut: Cut[] = [
    ...scored
      .filter((c) => c.score < context.minScore)
      .map((c) => ({ id: c.candidate.id, reason: "below the minimum score" })),
    ...pool.slice(context.consider).map((c) => ({
      id: c.candidate.id,
      reason: `outside the best ${context.consider} considered`,
    })),
  ];
  const pairs: [number, number][] = [];
  for (let i = 0; i < considered.length; i++) {
    for (let j = i + 1; j < considered.length; j++) pairs.push([i, j]);
  }
  return { considered, pairs, cut };
}

/**
 * Walk the considered candidates best first. One is cut when a better one
 * that was chosen covers the same ground, when the list is full, or when its
 * bucket is full. Every cut carries its reason.
 */
export function rank(context: RankContext) {
  const cut = [...context.cut];
  const ranked: Ranked[] = [];
  const chosen = new Set<number>();
  const perBucket = new Map<string, number>();
  context.considered.forEach(({ candidate, score }, position) => {
    const twin = context.duplicates.find(
      ([better, worse]) => worse === position && chosen.has(better),
    );
    const taken = perBucket.get(candidate.bucket) ?? 0;
    if (twin) {
      cut.push({
        id: candidate.id,
        reason: `duplicate of ${context.considered[twin[0]]!.candidate.id}`,
      });
    } else if (ranked.length >= context.top) {
      cut.push({ id: candidate.id, reason: `beyond the top ${context.top}` });
    } else if (taken >= context.perBucket) {
      cut.push({ id: candidate.id, reason: `bucket ${candidate.bucket} is full` });
    } else {
      chosen.add(position);
      perBucket.set(candidate.bucket, taken + 1);
      ranked.push({ id: candidate.id, title: candidate.title, bucket: candidate.bucket, score });
    }
  });
  return { ranked, cut };
}

/** The headline only: `ranked` and `cut` carry the rows, so a host never shows them twice. */
function renderSummary(context: RankContext): string {
  if (context.failure) return `Ranking failed: ${context.failure}`;
  return (
    `Ranked ${context.ranked.length} of ${context.candidates.length} candidates.` +
    (context.cut.length ? ` Cut ${context.cut.length}, each with its reason.` : "")
  );
}

const outputSchema = z.object({
  summary: z.string(),
  ranked: z.array(rankedSchema),
  cut: z.array(cutSchema),
});

function rankOutput(context: RankContext) {
  return { summary: renderSummary(context), ranked: context.ranked, cut: context.cut };
}

const agentSetup = setupAgent({
  context: contextSchema,
  input: inputSchema,
  output: outputSchema,
  // Both judgment phases are Jev (see createScoreCandidates, createFindDuplicates).
  actors: rankActors(),
});

export const rankCandidatesSchemas = agentSetup.schemas;

export const rankCandidatesMachine = agentSetup.createMachine({
  id: "rank-candidates",
  context: ({ input }) => ({
    brief: input.brief,
    candidates: input.candidates,
    top: input.top ?? DEFAULTS.top,
    consider: input.consider ?? DEFAULTS.consider,
    perBucket: input.perBucket ?? DEFAULTS.perBucket,
    minScore: input.minScore ?? DEFAULTS.minScore,
    scores: [],
    considered: [],
    pairs: [],
    duplicates: [],
    ranked: [],
    cut: [],
    failure: null,
  }),
  initial: "scoring",
  states: {
    scoring: {
      invoke: {
        src: "scoreCandidates",
        input: ({ context }) => ({ brief: context.brief, candidates: context.candidates }),
        onDone: ({ output }) => ({ target: "shortlisting", context: { scores: output.scores } }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `scoring failed: ${String(event.error)}` },
        }),
      },
    },
    // Pure code: threshold, sort, cut-off, pairs.
    shortlisting: {
      type: "choice",
      choice: ({ context }) => {
        const result = shortlist(context);
        return {
          target: result.pairs.length > 0 ? "deduping" : "ranking",
          context: result,
        };
      },
    },
    deduping: {
      invoke: {
        src: "findDuplicates",
        input: ({ context }) => ({
          pairs: context.pairs.map(([keep, other]) => ({
            keep: context.considered[keep]!.candidate,
            other: context.considered[other]!.candidate,
          })),
        }),
        onDone: ({ context, output }) => ({
          target: "ranking",
          context: {
            duplicates: context.pairs.filter((_, i) => output.same[i]! >= SAME_THRESHOLD),
          },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `deduping failed: ${String(event.error)}` },
        }),
      },
    },
    // Pure code: duplicates, list size, bucket quotas.
    ranking: {
      type: "choice",
      choice: ({ context }) => ({ target: "done", context: rank(context) }),
    },
    done: {
      type: "final",
      output: ({ context }) => rankOutput(context),
    },
    failed: {
      type: "final",
      output: ({ context }) => rankOutput(context),
    },
  },
});

export type RankCandidatesInput = z.infer<typeof inputSchema>;

export interface RunRankCandidatesOptions {
  input?: RankCandidatesInput;
  /** The judge model; tests pass a mock, the direct run uses Jev. */
  judge?: Experimental_DecisionModel;
  onProgress?: (state: string) => void;
}

/** `finalState` is `done`, or `failed` when a judgment call failed. */
export type RankCandidatesResult = z.infer<typeof outputSchema> & {
  finalState: string;
  progress: string[];
};

const talk = (id: string, bucket: string, title: string, summary: string): Candidate => ({
  id,
  bucket,
  title,
  summary,
});

/** A fictional conference programme for the direct run. */
export const SAMPLE_INPUT: RankCandidatesInput = {
  brief:
    "A one-day programme for engineers who run agent workflows in production: what breaks, how to see it, and how to keep cost and latency in hand.",
  top: 5,
  consider: 8,
  perBucket: 2,
  minScore: 1.5,
  candidates: [
    talk(
      "p01",
      "reliability",
      "What we learned from 400 failed runs",
      "A taxonomy of production failures in agent workflows and the checks that caught each one.",
    ),
    talk(
      "p02",
      "reliability",
      "Retries that do not repeat side effects",
      "Idempotency keys, uncertain outcomes and when a retry is safe.",
    ),
    talk(
      "p03",
      "reliability",
      "A field guide to agent workflow failures",
      "Failure classes seen in production runs and how each was detected.",
    ),
    talk(
      "p04",
      "observability",
      "Traces you can replay",
      "Recording every model call and tool call so a run can be inspected and rerun.",
    ),
    talk(
      "p05",
      "observability",
      "Dashboards nobody reads",
      "Which workflow metrics changed a decision, and which only filled a wall.",
    ),
    talk(
      "p06",
      "cost",
      "Pricing a loop before it runs",
      "Estimating spend for bounded loops and maps, and stopping on a budget.",
    ),
    talk(
      "p07",
      "cost",
      "Small models for typed judgments",
      "Moving routing and screening decisions off the large model.",
    ),
    talk(
      "p08",
      "reliability",
      "Timeouts, deadlines and clocks",
      "Why a one-second deadline fired at 999 ms, and other timer surprises.",
    ),
    talk("p09", "community", "Our team offsite in pictures", "Photos and stories from this year."),
  ],
};

/** Runs the ranking; records state progress. */
export async function runRankCandidatesExample(
  options: RunRankCandidatesOptions = {},
): Promise<RankCandidatesResult> {
  const { input = SAMPLE_INPUT, judge, onProgress } = options;
  const progress: string[] = [];
  const result = await runAgent(rankCandidatesMachine, {
    input,
    ...(judge ? { actors: rankActors(judge) } : {}),
    onTransition: (snapshot) => {
      const state = getStatePath(snapshot);
      progress.push(state);
      onProgress?.(state);
    },
  });

  if (result.status !== "done") {
    throw new Error(`Rank candidates example did not complete: ${result.status}`);
  }
  return { ...result.output, finalState: getStatePath(result.snapshot), progress };
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.TYPESAFE_AI_API_KEY) {
    console.error("Set TYPESAFE_AI_API_KEY to run this example.");
    process.exit(1);
  }
  void (async () => {
    const result = await runRankCandidatesExample({
      onProgress: (state) => console.log(`  → ${state}`),
    });
    console.log(`\n${result.summary}`);
    result.ranked.forEach((r, i) =>
      console.log(`${i + 1}. ${r.title} [${r.bucket}] (${r.id}, fit ${r.score.toFixed(2)})`),
    );
    result.cut.forEach((c) => console.log(`- cut ${c.id}: ${c.reason}`));
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
