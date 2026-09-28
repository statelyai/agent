/**
 * Test-only: an AI SDK evaluation model (the judge behind
 * `experimental_evaluate`) that answers from a script, so the SDK's own
 * validation and result shaping run over canned Jev answers with no key and no
 * network. The same pattern as `examples/mock-judge.ts`, plus the confidence
 * TypeSafe reports in `providerMetadata.typesafe.confidence`.
 *
 * Answers are keyed by question id: a label for `choice`, a probability for
 * `boolean`, a level index for `score`, or `{ value, confidence }` to set the
 * reported confidence (default 0.9). A function receives the request `state`.
 * A question with no answer throws. `calls` records every request.
 */
import type {
  Experimental_EvaluationModel as EvaluationModel,
  Experimental_EvaluationQuestion as EvaluationQuestion,
} from "ai";

type JudgeModel = Exclude<EvaluationModel, string>;
type CallOptions = Parameters<JudgeModel["doEvaluate"]>[0];
type ModelAnswer = Awaited<ReturnType<JudgeModel["doEvaluate"]>>["answers"][string];

type Answer = string | number | { value: string | number; confidence: number };

/** `share` of the probability mass on `winner`, the rest spread evenly. */
function distribution(labels: string[], winner: string, share: number) {
  const rest = labels.length > 1 ? (1 - share) / (labels.length - 1) : 0;
  return Object.fromEntries(labels.map((label) => [label, label === winner ? share : rest]));
}

function answerFor(question: EvaluationQuestion, raw: string | number): ModelAnswer {
  if (question.type === "boolean") return { type: "boolean", probability: Number(raw) };
  if (question.type === "choice") {
    const choice = String(raw);
    return {
      type: "choice",
      choice,
      probabilities: distribution(Object.keys(question.criteria), choice, 0.9),
    };
  }
  // All mass on the scripted level: the SDK checks that a score equals the
  // probability-weighted mean of its levels.
  const levels = question.criteria.map((_level, index) => String(index));
  return { type: "score", score: Number(raw), probabilities: distribution(levels, String(raw), 1) };
}

export function createTestJudge(answers: Record<string, Answer | ((state: any) => Answer)>) {
  const calls: Pick<CallOptions, "state" | "questions">[] = [];
  const model: JudgeModel = {
    specificationVersion: "v4",
    provider: "test-judge",
    modelId: "test-judge",
    supportedQuestionTypes: ["choice", "score", "boolean"],
    doEvaluate: async ({ state, questions }) => {
      calls.push({ state, questions });
      const out: Record<string, ModelAnswer> = {};
      const confidence: Record<string, number> = {};
      for (const [id, question] of Object.entries(questions)) {
        const entry = answers[id];
        if (entry === undefined) throw new Error(`test judge: no answer for "${id}"`);
        const answer = typeof entry === "function" ? entry(state) : entry;
        const scripted = typeof answer === "object" ? answer : { value: answer, confidence: 0.9 };
        out[id] = answerFor(question, scripted.value);
        confidence[id] = scripted.confidence;
      }
      return {
        answers: out,
        usage: { inputTokens: 0, outputTokens: 0 },
        warnings: [],
        providerMetadata: { typesafe: { confidence } },
        response: { modelId: "test-judge", timestamp: new Date(0) },
      };
    },
  };
  return { model, calls };
}
