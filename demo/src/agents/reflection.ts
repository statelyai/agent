/**
 * Reflection — a writer drafts, an evaluator scores, the machine loops.
 *
 * What the MODEL owns: writing the draft (`writeDraft`) and scoring it
 * (`evaluate` returns a numeric score plus feedback).
 * What the MACHINE owns: the revise/stop decision. The `checking` choice state
 * stops when the score clears the threshold OR the revision budget
 * (`maxRevisions = 2`) is spent — a named number you can point at, not a fixed,
 * implicit message-count loop. Below threshold, the critique feeds back into the
 * next draft.
 */
import { z } from "zod";
import { setupAgent } from "@statelyai/agent";

const MAX_REVISIONS = 2;
const SCORE_THRESHOLD = 8;

const evaluationSchema = z.object({
  score: z.number().min(0).max(10),
  feedback: z.string(),
});

const agentSetup = setupAgent({
  context: z.object({
    topic: z.string(),
    draft: z.string(),
    feedback: z.string().nullable(),
    score: z.number().nullable(),
    revisions: z.number(),
  }),
  input: z.object({ topic: z.string() }),
  output: z.object({
    draft: z.string(),
    score: z.number(),
    revisions: z.number(),
    accepted: z.boolean(),
  }),
  requests: {
    writeDraft: {
      schemas: {
        input: z.object({ topic: z.string(), feedback: z.string().nullable() }),
        output: z.string(),
      },
      model: "writer",
      system:
        "Write a short, vivid paragraph. If feedback is provided, revise to address every point while keeping what works.",
      prompt: ({ input }) =>
        input.feedback
          ? `Topic: ${input.topic}\n\nRevise to address this feedback:\n${input.feedback}`
          : `Topic: ${input.topic}`,
    },
    evaluate: {
      schemas: { input: z.object({ draft: z.string() }), output: evaluationSchema },
      model: "critic",
      // The rubric is deliberately strict: a vague "score it 0-10" prompt hands
      // out 8s and 9s to first drafts, and the revision loop never runs.
      system:
        "You are a demanding editor. Score the draft 0-10 against ALL four criteria: " +
        "(1) concrete, specific sensory detail rather than generic imagery; " +
        "(2) no clichés, filler, or throat-clearing; " +
        "(3) a clear controlling idea the paragraph actually builds to; " +
        "(4) varied rhythm and precise word choice, with no sagging sentence. " +
        "A score of 8 or above means every criterion is met and you cannot name a " +
        "single concrete improvement. First drafts almost never clear that bar — " +
        "if you can name any improvement at all, score 7 or below. Give specific, " +
        "actionable feedback naming the weakest criterion and how to fix it.",
      prompt: ({ input }) => `Score this draft:\n${input.draft}`,
    },
  },
  states: {
    evaluating: { context: { draft: z.string() } },
    checking: { context: { draft: z.string(), score: z.number() } },
  },
});

export const reflectionMachine = agentSetup.createMachine({
  id: "reflection",
  context: ({ input }) => ({
    topic: input.topic,
    draft: "",
    feedback: null,
    score: null,
    revisions: 0,
  }),
  initial: "drafting",
  states: {
    drafting: {
      invoke: {
        src: "writeDraft",
        input: ({ context }) => ({ topic: context.topic, feedback: context.feedback }),
        onDone: { target: "evaluating", context: ({ output }) => ({ draft: output }) },
        onError: { target: "done" },
      },
    },
    evaluating: {
      invoke: {
        src: "evaluate",
        input: ({ context }) => ({ draft: context.draft }),
        onDone: {
          target: "checking",
          context: ({ output }) => ({ score: output.score, feedback: output.feedback }),
        },
        onError: { target: "done" },
      },
    },
    // The loop bound: accept if good enough, else revise while budget remains.
    checking: {
      type: "choice",
      choice: ({ context }) =>
        (context.score ?? 0) >= SCORE_THRESHOLD || context.revisions >= MAX_REVISIONS
          ? { target: "done" }
          : { target: "drafting", context: { revisions: context.revisions + 1 } },
    },
    done: {
      type: "final",
      output: ({ context }) => ({
        draft: context.draft,
        score: context.score ?? 0,
        revisions: context.revisions,
        accepted: (context.score ?? 0) >= SCORE_THRESHOLD,
      }),
    },
  },
});
