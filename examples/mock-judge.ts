/**
 * Test-only double for an AI SDK evaluation model (the judge behind
 * `experimental_evaluate`), repo-internal and unpublished like
 * `mock-model.ts`. It implements the SDK's evaluation-model spec directly, the
 * way `MockLanguageModelV3` does for language models, so `experimental_evaluate`
 * runs its real validation and result shaping over scripted answers.
 *
 * Answers are keyed by QUESTION ID (the key in the `questions` map). An entry
 * is the answer value for that question's type, or a function of the request
 * `state` and the question that returns one:
 *   - boolean: a probability in [0, 1] (a boolean means 0.95 / 0.05)
 *   - choice:  the chosen label; `probabilities` are derived
 *   - score:   the level index; `probabilities` are derived
 * Entries for an id are consumed in order; the last one repeats. `"*"` is the
 * fallback id. A question with no entry throws naming it.
 */
import type {
  Experimental_EvaluationModel as EvaluationModel,
  Experimental_EvaluationQuestion as EvaluationQuestion,
} from "ai";

/** The spec object form of an evaluation model (not a registry id string). */
export type MockJudgeModel = Exclude<EvaluationModel, string>;
type CallOptions = Parameters<MockJudgeModel["doEvaluate"]>[0];
type Answer = Awaited<ReturnType<MockJudgeModel["doEvaluate"]>>["answers"][string];

export type MockJudgeAnswer = number | boolean | string;
export type MockJudgeEntry =
  | MockJudgeAnswer
  | ((
      state: CallOptions["state"],
      question: EvaluationQuestion,
    ) => MockJudgeAnswer | Promise<MockJudgeAnswer>);

export type MockJudgeCall = { state: CallOptions["state"]; questions: CallOptions["questions"] };

export type MockJudge = {
  /** Pass this wherever an example takes its judge model. */
  model: MockJudgeModel;
  /** Every evaluation request the model saw, in order. */
  calls: MockJudgeCall[];
};

/** Concentrates most probability mass on `winner` and spreads the rest. */
function distribution(labels: string[], winner: string, share = 0.9) {
  const rest = labels.length > 1 ? (1 - share) / (labels.length - 1) : 0;
  return Object.fromEntries(labels.map((label) => [label, label === winner ? share : rest]));
}

function answerFor(question: EvaluationQuestion, raw: MockJudgeAnswer, id: string): Answer {
  if (question.type === "boolean") {
    const probability = typeof raw === "boolean" ? (raw ? 0.95 : 0.05) : Number(raw);
    return { type: "boolean", probability };
  }
  if (question.type === "choice") {
    const labels = Object.keys(question.criteria);
    const choice = String(raw);
    if (!labels.includes(choice)) {
      throw new Error(
        `mock judge: "${choice}" is not a label of question "${id}" (${labels.join(", ")})`,
      );
    }
    return { type: "choice", choice, probabilities: distribution(labels, choice) };
  }
  const score = Number(raw);
  if (!Number.isInteger(score) || score < 0 || score >= question.criteria.length) {
    throw new Error(
      `mock judge: score ${raw} is outside question "${id}" (0..${question.criteria.length - 1})`,
    );
  }
  // The SDK checks a score against the probability-weighted mean of its
  // distribution, so a scripted level carries all of the weight.
  const levels = question.criteria.map((_, index) => String(index));
  return { type: "score", score, probabilities: distribution(levels, String(score), 1) };
}

/** An evaluation model that answers from the script. */
export function createMockJudge(
  script: Record<string, MockJudgeEntry | MockJudgeEntry[]>,
): MockJudge {
  const cursors = new Map<string, number>();
  const calls: MockJudgeCall[] = [];

  function take(id: string): MockJudgeEntry {
    const entries = script[id] ?? script["*"];
    if (entries === undefined)
      throw new Error(`mock judge: no scripted answer for question "${id}"`);
    const list = Array.isArray(entries) ? entries : [entries];
    const index = cursors.get(id) ?? 0;
    cursors.set(id, index + 1);
    return list[Math.min(index, list.length - 1)]!;
  }

  const model: MockJudgeModel = {
    specificationVersion: "v4",
    provider: "mock-judge",
    modelId: "mock-judge",
    supportedQuestionTypes: ["choice", "score", "boolean"],
    doEvaluate: async (options) => {
      calls.push({ state: options.state, questions: options.questions });
      const answers: Record<string, Answer> = {};
      for (const [id, question] of Object.entries(options.questions)) {
        const entry = take(id);
        const raw = typeof entry === "function" ? await entry(options.state, question) : entry;
        answers[id] = answerFor(question, raw, id);
      }
      return {
        answers,
        usage: { inputTokens: 0, outputTokens: 0 },
        warnings: [],
        response: { modelId: "mock-judge", timestamp: new Date(0) },
      };
    },
  };

  return { model, calls };
}
