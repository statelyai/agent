/**
 * Test-only double for an AI SDK decision model (the judge behind
 * `experimental_decide`), repo-internal and unpublished like
 * `mock-model.ts`. It implements the SDK's `doDecide` spec directly, the way
 * `MockLanguageModelV3` does for language models, so `experimental_decide`
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
  Experimental_DecisionModel as DecisionModel,
  Experimental_DecisionQuestion as DecisionQuestion,
} from "ai";

/**
 * The `doDecide` spec object form of a decision model (not a registry id
 * string or the deprecated `doEvaluate` spec).
 */
export type MockJudgeModel = Extract<DecisionModel, { doDecide: unknown }>;
type CallOptions = Parameters<MockJudgeModel["doDecide"]>[0];
type Answer = Awaited<ReturnType<MockJudgeModel["doDecide"]>>["answers"][string];

export type MockJudgeAnswer = number | boolean | string;
export type MockJudgeEntry =
  | MockJudgeAnswer
  | ((
      // The plain value the machine passed (see `machineState`), which
      // callers narrow themselves.
      state: unknown,
      question: DecisionQuestion,
    ) => MockJudgeAnswer | Promise<MockJudgeAnswer>);

export type MockJudgeCall = { state: unknown; questions: CallOptions["questions"] };

export type MockJudge = {
  /** Pass this wherever an example takes its judge model. */
  model: MockJudgeModel;
  /** Every decision request the model saw, in order. */
  calls: MockJudgeCall[];
};

/** Concentrates most probability mass on `winner` and spreads the rest. */
function distribution(labels: string[], winner: string, share = 0.9) {
  const rest = labels.length > 1 ? (1 - share) / (labels.length - 1) : 0;
  return Object.fromEntries(labels.map((label) => [label, label === winner ? share : rest]));
}

function answerFor(question: DecisionQuestion, raw: MockJudgeAnswer, id: string): Answer {
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

/**
 * The value the machine passed as `state`. The SDK hands a model its state as
 * parts, wrapping a plain value in one `{ type: 'json', value }` part; scripts
 * and assertions read the value the machine actually sent.
 */
function machineState(state: CallOptions["state"]): unknown {
  const [part] = state;
  return state.length === 1 && part?.type === "json" ? part.value : state;
}

/** A decision model that answers from the script. */
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
    doDecide: async (options) => {
      const state = machineState(options.state);
      calls.push({ state, questions: options.questions });
      const answers: Record<string, Answer> = {};
      for (const [id, question] of Object.entries(options.questions)) {
        const entry = take(id);
        const raw = typeof entry === "function" ? await entry(state, question) : entry;
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
