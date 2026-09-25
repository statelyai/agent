/**
 * Reflection — a writer drafts, Jev scores, the machine loops.
 *
 * What the MODEL owns: writing the draft (`writeDraft`, a text request).
 * What JEV owns: scoring it (`evaluate`). Grading a draft against a rubric is a
 * typed judgment over text the machine holds, not a generation, so it goes to
 * TypeSafe's System One model: one `score` on the described levels in
 * `QUALITY_LEVELS`, plus one `noul` per criterion in the same call. The
 * criteria Jev reads as unmet become the feedback for the next draft.
 * What the MACHINE owns: the revise/stop decision. The `checking` choice state
 * stops when the score clears `SCORE_THRESHOLD` OR the revision budget
 * (`MAX_REVISIONS = 2`) is spent — named numbers you can point at, not a fixed,
 * implicit message-count loop.
 */
import { z } from "zod";
import { noul, score, type TypeSafeClient } from "@typesafe-ai/sdk";
import { setupAgent } from "@statelyai/agent";
import { createSystemOneLogic } from "@statelyai/agent/typesafe";

const MAX_REVISIONS = 2;

/**
 * The rubric, lowest first. The levels are deliberately strict: a vague
 * "score it" rubric rates first drafts near the top, and the revision loop
 * never runs.
 */
const QUALITY_LEVELS = [
  "Generic throughout: no concrete detail, clichés or filler, and no idea it builds to.",
  "Mostly generic: one concrete detail at most, with clichés or filler and no clear idea.",
  "Mixed: some concrete detail and a discernible idea, but clichés, filler, or sagging sentences remain.",
  "Strong: concrete detail and a clear idea it builds to, with one small weakness in rhythm or word choice.",
  "Every criterion met: concrete sensory detail, no clichés or filler, a controlling idea, varied rhythm, and precise words.",
] as const;

/** The top rubric level. */
const MAX_SCORE = QUALITY_LEVELS.length - 1;
/** Accept a draft whose expected level reaches this. */
export const SCORE_THRESHOLD = 3;
/** A criterion counts as met when Jev's probability that it holds clears this. */
export const CRITERION_THRESHOLD = 0.5;

/** Each criterion's question, and the revision note when Jev reads it as unmet. */
const CRITERIA = {
  concrete: {
    question: "Does `draft` use concrete, specific sensory detail rather than generic imagery?",
    fix: "Replace generic imagery with concrete, specific sensory detail.",
  },
  noFiller: {
    question: "Is `draft` free of clichés, filler, and throat-clearing?",
    fix: "Cut the clichés, filler, and throat-clearing.",
  },
  controllingIdea: {
    question: "Does `draft` build to one clear controlling idea?",
    fix: "Give the paragraph one clear idea and build to it.",
  },
  rhythm: {
    question: "Does `draft` vary its sentence rhythm and choose words precisely?",
    fix: "Vary the sentence rhythm and replace imprecise words.",
  },
} as const;

/** The evaluator as one Jev call: a rubric `score` and a `noul` per criterion. */
export function createEvaluate(client?: TypeSafeClient) {
  return createSystemOneLogic({
    client,
    state: (input: { topic: string; draft: string }) => ({
      topic: input.topic,
      draft: input.draft,
    }),
    questions: () => ({
      quality: score(
        "How well does `draft`, a one-paragraph piece about `topic`, meet all four criteria: " +
          "concrete sensory detail, no clichés or filler, a controlling idea, and varied rhythm " +
          "with precise words?",
        QUALITY_LEVELS,
      ),
      concrete: noul(CRITERIA.concrete.question),
      noFiller: noul(CRITERIA.noFiller.question),
      controllingIdea: noul(CRITERIA.controllingIdea.question),
      rhythm: noul(CRITERIA.rhythm.question),
    }),
  });
}

/** Renders the revision notes from the criteria Jev read as unmet. */
function feedbackFrom(met: Record<keyof typeof CRITERIA, number>): string {
  const notes = (Object.keys(CRITERIA) as (keyof typeof CRITERIA)[])
    .filter((name) => met[name] < CRITERION_THRESHOLD)
    .map((name) => CRITERIA[name].fix);
  return notes.length ? notes.join(" ") : "Tighten the weakest sentence.";
}

/** A Jev score is an expected level, so it can fall between levels. */
function formatScore(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

const reflectionContextSchema = z.object({
  topic: z.string(),
  /** The untouched first pass, kept so the before/after is visible at the end. */
  firstDraft: z.string(),
  draft: z.string(),
  feedback: z.string().nullable(),
  score: z.number().nullable(),
  revisions: z.number(),
  /** Plain-language result: target reached, or best effort once the budget ran out. */
  verdict: z.string(),
});

const agentSetup = setupAgent({
  context: reflectionContextSchema,
  input: z.object({ topic: z.string() }),
  output: z.object({
    firstDraft: z.string(),
    draft: z.string(),
    score: z.number(),
    revisions: z.number(),
    accepted: z.boolean(),
    verdict: z.string(),
  }),
  actors: { evaluate: createEvaluate() },
  requests: {
    writeDraft: {
      schemas: {
        input: z.object({ topic: z.string(), feedback: z.string().nullable() }),
        output: z.string(),
      },
      model: "writer",
      system:
        "Write a short paragraph. If feedback is provided, revise to address every point while keeping what works.",
      // The first pass is deliberately weak, so the loop has something to improve
      // and the before/after is worth looking at. Without it the writer opens
      // near the bar and the revision states barely earn their place.
      prompt: ({ input }) =>
        input.feedback
          ? `Topic: ${input.topic}\n\nRevise to address this feedback:\n${input.feedback}`
          : `Topic: ${input.topic}\n\nFirst pass only: two flat, generic sentences. No sensory detail, no polish, no strong verbs.`,
    },
  },
  states: {
    checking: { schemas: { context: reflectionContextSchema.extend({ score: z.number() }) } },
  },
});

export const reflectionMachine = agentSetup.createMachine({
  id: "reflection",
  context: ({ input }) => ({
    topic: input.topic,
    firstDraft: "",
    draft: "",
    feedback: null,
    score: null,
    revisions: 0,
    verdict: "",
  }),
  initial: "drafting",
  states: {
    drafting: {
      invoke: {
        src: "writeDraft",
        input: ({ context }) => ({ topic: context.topic, feedback: context.feedback }),
        onDone: {
          target: "evaluating",
          context: ({ context, output }) => ({
            draft: output.result,
            // Only the first pass is preserved; later drafts overwrite `draft` alone.
            firstDraft: context.firstDraft || output.result,
          }),
        },
        onError: { target: "done" },
      },
    },
    evaluating: {
      invoke: {
        src: "evaluate",
        input: ({ context }) => ({ topic: context.topic, draft: context.draft }),
        onDone: {
          target: "checking",
          context: ({ output }) => {
            const { quality, concrete, noFiller, controllingIdea, rhythm } = output.answers;
            return {
              score: quality.score,
              feedback: feedbackFrom({
                concrete: concrete.noul,
                noFiller: noFiller.noul,
                controllingIdea: controllingIdea.noul,
                rhythm: rhythm.noul,
              }),
            };
          },
        },
        onError: { target: "done" },
      },
    },
    // The loop bound: accept if good enough, else revise while budget remains.
    // Either way the exit is labelled, so a run that stops short of the target
    // reads as a bounded best effort rather than a silent failure.
    checking: {
      type: "choice",
      choice: ({ context }) => {
        const score = context.score ?? 0;
        const rounds = `${context.revisions} revision${context.revisions === 1 ? "" : "s"}`;
        if (score >= SCORE_THRESHOLD) {
          return {
            target: "done",
            context: {
              verdict: `Reached target in ${rounds} (score ${formatScore(score)}/${MAX_SCORE}).`,
            },
          };
        }
        if (context.revisions >= MAX_REVISIONS) {
          return {
            target: "done",
            context: {
              verdict: `Best effort after ${rounds} (score ${formatScore(score)}/${MAX_SCORE}, target ${SCORE_THRESHOLD}/${MAX_SCORE}).`,
            },
          };
        }
        return { target: "drafting", context: { revisions: context.revisions + 1 } };
      },
    },
    done: {
      type: "final",
      output: ({ context }) => ({
        firstDraft: context.firstDraft,
        draft: context.draft,
        score: context.score ?? 0,
        revisions: context.revisions,
        accepted: (context.score ?? 0) >= SCORE_THRESHOLD,
        verdict: context.verdict,
      }),
    },
  },
});
