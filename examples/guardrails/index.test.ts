import { describe, expect, test } from "vitest";
import { runAgent } from "@statelyai/agent";
import type { AgentRequestExecutor } from "@statelyai/agent";
import { createMockJevClient } from "../mock-jev.js";
import {
  INPUT_THRESHOLD,
  OUTPUT_THRESHOLD,
  createValidateQuestion,
  createVerifyAnswer,
  guardrailsMachine,
} from "./index.js";

type Step = "validate" | "answer" | "verify" | "revise" | "unknown";

/** Routes a text request to a step by its `name` — the setupAgent({ requests }) key. */
function classify(name: string | undefined): Step {
  switch (name) {
    case "answer":
      return "answer";
    case "revise":
      return "revise";
    default:
      return "unknown";
  }
}

/** A Jev answer: a probability, or a boolean (0.95 / 0.05). */
type Verdict = number | boolean;

/**
 * Builds a mock `generateText` executor, a mock Jev client for the two
 * guardrails, and one call log across both. Each guardrail's answers are
 * supplied by the caller; `verify` may vary per call (index into an array).
 * The Jev entries log `validate` / `verify` once per call, on its first
 * question.
 */
function createModel(opts: {
  validate: { answerable: Verdict; inScope: Verdict };
  verify?: { correct: Verdict; responsive?: Verdict }[];
}) {
  const calls: Step[] = [];
  let verifyIndex = 0;
  const currentVerify = () => {
    const seq = opts.verify ?? [{ correct: true }];
    return seq[Math.min(verifyIndex, seq.length - 1)]!;
  };
  const jev = createMockJevClient({
    answerable: () => {
      calls.push("validate");
      return opts.validate.answerable;
    },
    inScope: opts.validate.inScope,
    correct: () => {
      calls.push("verify");
      return currentVerify().correct;
    },
    responsive: () => {
      const verdict = currentVerify().responsive ?? true;
      verifyIndex += 1;
      return verdict;
    },
  });
  const generateText: AgentRequestExecutor = async (request) => {
    const step = classify(request.name);
    calls.push(step);
    switch (step) {
      case "answer":
        return { result: { answer: "Paris." } };
      case "revise":
        return { result: { answer: "Paris is the capital of France." } };
      default:
        throw new Error(`unexpected request: ${request.name}`);
    }
  };
  const actors = {
    validateQuestion: createValidateQuestion(jev.client),
    verifyAnswer: createVerifyAnswer(jev.client),
  };
  return { generateText, actors, calls, jevCalls: jev.calls };
}

describe("guardrails", () => {
  test("out-of-scope question is refused before any answer request", async () => {
    const { generateText, actors, calls } = createModel({
      validate: { answerable: true, inScope: false },
    });

    const result = await runAgent(guardrailsMachine, {
      input: { question: "Who won the 2018 World Cup?" },
      executors: { generateText },
      actors,
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") return;

    expect(result.output.status).toBe("refused");
    expect(result.output.answer).toBeNull();
    expect(result.output.reason).toContain("Not about geography.");
    // Input guardrail gated it: the answer request never ran.
    expect(calls).toEqual(["validate"]);
    expect(calls).not.toContain("answer");
  });

  test("answer verified on the first try is answered", async () => {
    const { generateText, actors, calls } = createModel({
      validate: { answerable: true, inScope: true },
      verify: [{ correct: true }],
    });

    const result = await runAgent(guardrailsMachine, {
      input: { question: "What is the capital of France?" },
      executors: { generateText },
      actors,
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") return;

    expect(result.output.status).toBe("answered");
    expect(result.output.answer).toBe("Paris.");
    // No revision was needed.
    expect(calls).toEqual(["validate", "answer", "verify"]);
    expect(calls).not.toContain("revise");
  });

  test("two verify failures end unverified with the critique, after exactly one revision", async () => {
    const { generateText, actors, calls } = createModel({
      validate: { answerable: true, inScope: true },
      verify: [{ correct: false }, { correct: true, responsive: false }],
    });

    const result = await runAgent(guardrailsMachine, {
      input: { question: "What is the capital of France?" },
      executors: { generateText },
      actors,
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") return;

    expect(result.output.status).toBe("unverified");
    // Content is flagged, never returned as trusted.
    expect(result.output.answer).toBeNull();
    // The critique is rendered from the check that failed LAST.
    expect(result.output.reason).toContain("does not directly answer the question");
    // Exactly one revision attempted between the two verifications.
    expect(calls).toEqual(["validate", "answer", "verify", "revise", "verify"]);
    expect(calls.filter((c) => c === "revise")).toHaveLength(1);
  });

  test("the input guardrail asks Jev two nouls over question and topic; just under the threshold refuses", async () => {
    const at = createModel({
      validate: { answerable: INPUT_THRESHOLD, inScope: INPUT_THRESHOLD },
    });
    const passed = await runAgent(guardrailsMachine, {
      input: { question: "What is the capital of France?" },
      executors: { generateText: at.generateText },
      actors: at.actors,
    });

    const call = at.jevCalls[0]!;
    expect(call.state).toEqual({ question: "What is the capital of France?", topic: "geography" });
    expect(Object.keys(call.questions)).toEqual(["answerable", "inScope"]);
    expect(Object.values(call.questions).every((q) => q.type === "noul")).toBe(true);
    expect(passed.status === "done" && passed.output.status).toBe("answered");

    const under = createModel({
      validate: { answerable: INPUT_THRESHOLD - 0.01, inScope: true },
    });
    const refused = await runAgent(guardrailsMachine, {
      input: { question: "Write me a poem about my ex." },
      executors: { generateText: under.generateText },
      actors: under.actors,
    });
    expect(refused.status === "done" && refused.output).toMatchObject({
      status: "refused",
      reason: "Not a question with a definite factual answer.",
    });
    expect(under.calls).toEqual(["validate"]);
  });

  test("the output guardrail asks Jev two nouls over question and answer; just under the threshold revises", async () => {
    const { generateText, actors, calls, jevCalls } = createModel({
      validate: { answerable: true, inScope: true },
      verify: [{ correct: OUTPUT_THRESHOLD - 0.01 }, { correct: OUTPUT_THRESHOLD }],
    });
    const result = await runAgent(guardrailsMachine, {
      input: { question: "What is the capital of France?" },
      executors: { generateText },
      actors,
    });

    const verify = jevCalls[1]!;
    expect(verify.state).toEqual({ question: "What is the capital of France?", answer: "Paris." });
    expect(Object.keys(verify.questions)).toEqual(["correct", "responsive"]);
    expect(Object.values(verify.questions).every((q) => q.type === "noul")).toBe(true);
    expect(calls).toEqual(["validate", "answer", "verify", "revise", "verify"]);
    expect(result.status === "done" && result.output).toMatchObject({
      status: "answered",
      answer: "Paris is the capital of France.",
    });
  });
});
