/**
 * Test-only: a real `TypeSafeClient` over a scripted `fetch`, so the SDK's own
 * request building and response parsing run against canned Jev answers with
 * no key and no network.
 *
 * Answers are keyed by question name: a label for `choice`, a probability for
 * `noul`, a level index for `score`, or `{ value, confidence }` to set the
 * reported confidence (default 0.9). A function receives the request `state`.
 * `calls` records every request body.
 */
import { TypeSafeClient } from "@typesafe-ai/sdk";

type Answer = string | number | { value: string | number; confidence: number };
type Body = {
  state: unknown;
  model: string;
  questions: Record<string, { type: string; criteria?: unknown }>;
};

export function createTestJev(answers: Record<string, Answer | ((state: any) => Answer)>) {
  const calls: Body[] = [];
  const client = new TypeSafeClient({
    apiKey: "test-key",
    retry: { maxRetries: 0 },
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Body;
      calls.push(body);
      const out = Object.fromEntries(
        Object.entries(body.questions).map(([name, question]) => {
          const entry = answers[name];
          if (entry === undefined) throw new Error(`test jev: no answer for "${name}"`);
          const answer = typeof entry === "function" ? entry(body.state) : entry;
          const { value: raw, confidence } =
            typeof answer === "object" ? answer : { value: answer, confidence: 0.9 };
          if (question.type === "noul") return [name, { type: "noul", noul: Number(raw) }];
          const labels = Array.isArray(question.criteria)
            ? question.criteria.map((_level, index) => String(index))
            : Object.keys(question.criteria as object);
          const probabilities = Object.fromEntries(
            labels.map((label) => [label, label === String(raw) ? 0.9 : 0.1 / (labels.length - 1)]),
          );
          return question.type === "choice"
            ? [name, { type: "choice", choice: raw, confidence, probabilities }]
            : [name, { type: "score", score: raw, confidence, legend: {}, probabilities }];
        }),
      );
      return Response.json({
        model: body.model,
        answers: out,
        usage: { input_tokens: 0, output_tokens: 0 },
      });
    },
  });
  return { client, calls };
}
