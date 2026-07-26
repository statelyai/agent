import { expect, test } from "vitest";
import { runSimulatedUserEvaluationExample } from "./index.js";

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
