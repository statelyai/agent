/**
 * Test-only double for TypeSafe System One (Jev) calls, built on the real
 * `TypeSafeClient` with a scripted `fetch`. Repo-internal and unpublished,
 * like `mock-model.ts`: the SDK's own request building, validation, and
 * response parsing run for real; only the HTTP round-trip is scripted.
 *
 * Answers are keyed by QUESTION NAME (the key in the `questions` map). An
 * entry is the answer value for that question's type, or a function of the
 * request `state` and the question that returns one:
 *   - noul:   a probability in [0, 1] (a boolean means 0.95 / 0.05)
 *   - choice: the chosen label; `probabilities` and `confidence` are derived
 *   - score:  the level index; `legend` and `probabilities` are derived
 * Entries for a name are consumed in order; the last one repeats. `"*"` is
 * the fallback name. A question with no entry throws naming it.
 */
import {
  TypeSafeClient,
  type ChoiceQuestion,
  type EntryType,
  type NoulQuestion,
  type Question,
  type Questions,
  type ScoreQuestion,
} from "@typesafe-ai/sdk";

export type MockJevAnswer = number | boolean | string;
export type MockJevEntry =
  | MockJevAnswer
  | ((state: EntryType, question: Question) => MockJevAnswer | Promise<MockJevAnswer>);

export type MockJevCall = { state: EntryType; questions: Questions; model: string };

export type MockJevClient = {
  client: TypeSafeClient;
  /** Every System One request the client sent, in order. */
  calls: MockJevCall[];
};

/** Concentrates most probability mass on `winner` and spreads the rest. */
function distribution(labels: string[], winner: string, share = 0.9) {
  const rest = labels.length > 1 ? (1 - share) / (labels.length - 1) : 0;
  return Object.fromEntries(labels.map((label) => [label, label === winner ? share : rest]));
}

function answerFor(question: Question, raw: MockJevAnswer, name: string) {
  if (question.type === "noul") {
    const noul = typeof raw === "boolean" ? (raw ? 0.95 : 0.05) : Number(raw);
    return { type: "noul", noul };
  }
  if (question.type === "choice") {
    const labels = Object.keys((question as ChoiceQuestion).criteria);
    const choice = String(raw);
    if (!labels.includes(choice)) {
      throw new Error(
        `mock jev: "${choice}" is not a label of question "${name}" (${labels.join(", ")})`,
      );
    }
    return { type: "choice", choice, confidence: 0.9, probabilities: distribution(labels, choice) };
  }
  const criteria = (question as ScoreQuestion).criteria;
  const score = Number(raw);
  if (!Number.isInteger(score) || score < 0 || score >= criteria.length) {
    throw new Error(
      `mock jev: score ${raw} is outside question "${name}" (0..${criteria.length - 1})`,
    );
  }
  const levels = criteria.map((_, index) => String(index));
  return {
    type: "score",
    score,
    confidence: 0.9,
    legend: Object.fromEntries(criteria.map((level, index) => [String(index), level])),
    probabilities: distribution(levels, String(score)),
  };
}

/**
 * A real `TypeSafeClient` whose `fetch` answers `/v1/systemone` from the
 * script. Pass `client` to `createSystemOneLogic({ client })`.
 */
export function createMockJevClient(
  script: Record<string, MockJevEntry | MockJevEntry[]>,
): MockJevClient {
  const cursors = new Map<string, number>();
  const calls: MockJevCall[] = [];

  function take(name: string): MockJevEntry {
    const entries = script[name] ?? script["*"];
    if (entries === undefined)
      throw new Error(`mock jev: no scripted answer for question "${name}"`);
    const list = Array.isArray(entries) ? entries : [entries];
    const index = cursors.get(name) ?? 0;
    cursors.set(name, index + 1);
    return list[Math.min(index, list.length - 1)]!;
  }

  const client = new TypeSafeClient({
    apiKey: "test-key",
    retry: { maxRetries: 0 },
    fetch: async (url, init) => {
      if (!url.endsWith("/v1/systemone")) {
        return new Response(JSON.stringify({ error: `unexpected ${url}` }), { status: 404 });
      }
      const body = JSON.parse(String(init?.body)) as MockJevCall;
      calls.push(body);
      const answers: Record<string, unknown> = {};
      for (const [name, question] of Object.entries(body.questions)) {
        const entry = take(name);
        const raw =
          typeof entry === "function" ? await entry(body.state, question as Question) : entry;
        answers[name] = answerFor(question as Question, raw, name);
      }
      return new Response(
        JSON.stringify({
          model: body.model,
          answers,
          usage: { input_tokens: 0, output_tokens: 0 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  return { client, calls };
}

// Re-exported so a test can name a question's shape without a second import.
export type { NoulQuestion };
