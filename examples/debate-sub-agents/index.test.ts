import { describe, expect, test } from "vitest";
import type { AgentRequestExecutor } from "../../src/index.js";
import { runDebateSubAgentsExample } from "./index.js";

/**
 * A mock `generateText` that records every request and returns distinguishable
 * outputs per role. Debater requests are attributed by `request.model` (the
 * stance drives the model ref); the facilitator request echoes the transcript
 * it received so the test can prove the conclusion saw both sides.
 */
function createMockModel() {
  const requests: { model: string; system: string; prompt: string }[] = [];
  const generateText: AgentRequestExecutor = async (request) => {
    requests.push({
      model: request.model,
      system: request.system ?? "",
      prompt: request.prompt ?? "",
    });
    if (request.model === "facilitator") {
      const transcript = (request.prompt ?? "").split("Transcript: ")[1] ?? "";
      return { output: `verdict over ${transcript}` };
    }
    return { output: `${request.model}-argument` };
  };
  return { generateText, requests };
}

describe("debate-sub-agents", () => {
  test("facilitator alternates A/B turns, then concludes over both sides", async () => {
    const { generateText, requests } = createMockModel();

    const output = await runDebateSubAgentsExample({
      input: { question: "Should agents be modeled as actors?", rounds: 3 },
      generateText,
    });

    const debaterRequests = requests.filter((r) => r.model !== "facilitator");
    const facilitatorRequests = requests.filter((r) => r.model === "facilitator");

    // 3 rounds × 2 sides = 6 debater turns, alternating affirmative/negative.
    expect(debaterRequests.map((r) => r.model)).toEqual([
      "affirmative",
      "negative",
      "affirmative",
      "negative",
      "affirmative",
      "negative",
    ]);

    // Each debater's request carried its own stance-specific system prompt.
    for (const req of debaterRequests) {
      expect(req.system).toContain(`argue the ${req.model} side`);
    }

    // Transcript respects the round count and turn order.
    expect(output.transcript).toHaveLength(6);
    expect(output.transcript.map((t) => [t.stance, t.round])).toEqual([
      ["affirmative", 1],
      ["negative", 1],
      ["affirmative", 2],
      ["negative", 2],
      ["affirmative", 3],
      ["negative", 3],
    ]);

    // Exactly one conclusion, and it incorporated both sides' arguments.
    expect(facilitatorRequests).toHaveLength(1);
    expect(facilitatorRequests[0]!.system).toContain("BOTH");
    expect(output.conclusion).toContain("affirmative-argument");
    expect(output.conclusion).toContain("negative-argument");
  });

  test("round count is honored — 1 round is a single A/B exchange", async () => {
    const { generateText, requests } = createMockModel();

    const output = await runDebateSubAgentsExample({
      input: { question: "Tabs or spaces?", rounds: 1 },
      generateText,
    });

    expect(output.transcript.map((t) => t.stance)).toEqual(["affirmative", "negative"]);
    expect(requests.filter((r) => r.model !== "facilitator")).toHaveLength(2);
  });
});
