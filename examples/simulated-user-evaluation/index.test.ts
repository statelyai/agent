import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { runSimulatedUserEvaluationExample, SUPPORT_PLAYBOOK } from "./index.js";

test("alternates chatbot and simulated user, then evaluates", async () => {
  const calls: string[] = [];
  const output = await runSimulatedUserEvaluationExample({
    scenario: "Change an address",
    opening: "Help",
    maxTurns: 3,
    generateText: async (request) => {
      calls.push(request.model);
      if (request.model === "chatbot") return { output: "What is your order number?" };
      if (request.model === "simulatedUser") {
        return { output: { message: "Order 42", finished: true } };
      }
      return { output: { score: 4, feedback: "Clear next step." } };
    },
  });

  expect(calls).toEqual(["chatbot", "simulatedUser", "evaluator"]);
  expect(output.transcript.map(({ role }) => role)).toEqual(["user", "assistant", "user"]);
  expect(output.score).toBe(4);
});

test("the playbook is the only difference between the two baselines", async () => {
  const systems: string[] = [];
  const run = (playbook: string) =>
    runSimulatedUserEvaluationExample({
      scenario: "Late package",
      opening: "Help",
      maxTurns: 1,
      playbook,
      generateText: async (request) => {
        if (request.model === "chatbot") {
          systems.push(request.system ?? "");
          return { output: "ok" };
        }
        if (request.model === "simulatedUser") {
          return { output: { message: "thanks", finished: true } };
        }
        return { output: { score: playbook ? 5 : 0, feedback: "" } };
      },
    });

  const bare = await run("");
  const equipped = await run(SUPPORT_PLAYBOOK);

  // Bare bot: no product knowledge in its system prompt.
  expect(systems[0]).not.toContain("support playbook");
  // Passing baseline: the playbook is there for it to answer from.
  expect(systems[1]).toContain("Refunds settle in 5-7 business days");
  expect(equipped.score).toBeGreaterThan(bare.score);
});

test("both baseline starters are runnable and differ only by playbook", () => {
  const starters = JSON.parse(readFileSync(new URL("./metadata.json", import.meta.url), "utf8"))
    .starters as Array<{ label: string; input: Record<string, string> }>;
  const baselines = starters.filter((starter) => starter.label.startsWith("Baseline"));

  expect(baselines).toHaveLength(2);
  expect(baselines[0]!.input.scenario).toBe(baselines[1]!.input.scenario);
  expect(baselines[0]!.input.playbook).toBe("");
  expect(baselines[1]!.input.playbook).toBe(SUPPORT_PLAYBOOK);
});

test("turn budget stops an unfinished simulation", async () => {
  let chatbotCalls = 0;
  const output = await runSimulatedUserEvaluationExample({
    scenario: "Support",
    opening: "Help",
    maxTurns: 2,
    generateText: async (request) => {
      if (request.model === "chatbot") {
        chatbotCalls++;
        return { output: "Tell me more." };
      }
      if (request.model === "simulatedUser") {
        return { output: { message: "Still unresolved", finished: false } };
      }
      return { output: { score: 1, feedback: "Goal not met." } };
    },
  });

  expect(chatbotCalls).toBe(2);
  expect(output.score).toBe(1);
});
