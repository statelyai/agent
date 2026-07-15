import { describe, expect, test } from "vitest";
import type { AgentMessage } from "../../src/index.js";
import { runDescribedWorkflowExample } from "./index.js";

describe("described-workflow", () => {
  test("interprets the plain machine's descriptions into a full run", async () => {
    let judged = 0;
    const messages = (await runDescribedWorkflowExample({
      generateText: async (request) => {
        const prompt = String(request.messages?.at(-1)?.content ?? "");
        return {
          output: prompt.startsWith("List the three")
            ? "1. Visual. 2. Executable. 3. Verifiable."
            : "Statechart Studio turns your logic into diagrams you can run.",
        };
      },
      decide: async () => {
        judged += 1;
        return { event: { type: judged === 1 ? "REVISE" : "APPROVE" } };
      },
    })) as AgentMessage[];

    // outline → draft → judge(REVISE) → draft → judge(APPROVE):
    // 2 user/assistant pairs per text step (3 text steps) + 2 judge prompts + 2 choices.
    expect(judged).toBe(2);
    expect(messages.filter((message) => message.role === "assistant")).toHaveLength(5);
    expect(messages.at(-1)?.content).toBe("[chose: APPROVE]");
  });
});
