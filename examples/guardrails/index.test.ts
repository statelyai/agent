import { describe, expect, test } from "vitest";
import { runAgent } from "../../src/index.js";
import type { AgentRequestExecutor } from "../../src/index.js";
import { guardrailsMachine } from "./index.js";

type Step = "validate" | "answer" | "verify" | "revise" | "unknown";

/** Routes a request to a step by its `name` — the setupAgent({ requests }) key. */
function classify(name: string | undefined): Step {
  switch (name) {
    case "validateQuestion":
      return "validate";
    case "answer":
      return "answer";
    case "verifyAnswer":
      return "verify";
    case "revise":
      return "revise";
    default:
      return "unknown";
  }
}

/**
 * Builds a mock `generateText` executor plus a call log. Each step's output is
 * supplied by the caller; `verify` may vary per call (index into an array).
 */
function createModel(opts: {
  validate: { answerable: boolean; inScope: boolean; reason: string };
  verify?: { supported: boolean; critique: string }[];
}) {
  const calls: Step[] = [];
  let verifyIndex = 0;
  const generateText: AgentRequestExecutor = async (request) => {
    const step = classify(request.name);
    calls.push(step);
    switch (step) {
      case "validate":
        return { output: opts.validate };
      case "answer":
        return { output: { answer: "Paris." } };
      case "verify": {
        const seq = opts.verify ?? [{ supported: true, critique: "" }];
        return { output: seq[Math.min(verifyIndex++, seq.length - 1)] };
      }
      case "revise":
        return { output: { answer: "Paris is the capital of France." } };
      default:
        throw new Error(`unexpected request: ${request.name}`);
    }
  };
  return { generateText, calls };
}

describe("guardrails", () => {
  test("out-of-scope question is refused before any answer request", async () => {
    const { generateText, calls } = createModel({
      validate: { answerable: true, inScope: false, reason: "Not about geography." },
    });

    const result = await runAgent(guardrailsMachine, {
      input: { question: "Who won the 2018 World Cup?", topic: "geography" },
      executors: { generateText },
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
    const { generateText, calls } = createModel({
      validate: { answerable: true, inScope: true, reason: "Fine." },
      verify: [{ supported: true, critique: "" }],
    });

    const result = await runAgent(guardrailsMachine, {
      input: { question: "What is the capital of France?", topic: "geography" },
      executors: { generateText },
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
    const { generateText, calls } = createModel({
      validate: { answerable: true, inScope: true, reason: "Fine." },
      verify: [
        { supported: false, critique: "Unsupported claim." },
        { supported: false, critique: "Still unsupported." },
      ],
    });

    const result = await runAgent(guardrailsMachine, {
      input: { question: "What is the capital of France?", topic: "geography" },
      executors: { generateText },
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") return;

    expect(result.output.status).toBe("unverified");
    // Content is flagged, never returned as trusted.
    expect(result.output.answer).toBeNull();
    expect(result.output.reason).toContain("Still unsupported.");
    // Exactly one revision attempted between the two verifications.
    expect(calls).toEqual(["validate", "answer", "verify", "revise", "verify"]);
    expect(calls.filter((c) => c === "revise")).toHaveLength(1);
  });
});
