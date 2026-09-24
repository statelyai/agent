import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { lintAgentMachine } from "@statelyai/agent/testing";
import { createMockModelExecutors } from "../mock-model.js";
import {
  DEFAULT_BOT_SYSTEM,
  MAX_EXCHANGES,
  REFUND_PERSONA,
  chatbotSimulationEvalMachine,
  runChatbotSimulationEvalExample,
} from "./index.js";

const judged = { passed: true, verdict: "Declined the refund and offered credit.", score: 9 };

test("the customer finishes → one more bot reply → judged, endedBy user", async () => {
  const executors = createMockModelExecutors({
    text: {
      simulateUser: [
        { message: "I want a full refund for my Alaska trip.", finished: false },
        { message: "Fine, forget it.", finished: true },
      ],
      supportBot: [
        { message: "That trip is past our 30-day refund window; I can offer travel credit." },
        { message: "Sorry I couldn't help more. Have a good day." },
      ],
      judgeConversation: [judged],
    },
  });
  const result = await runChatbotSimulationEvalExample({ generateText: executors.generateText });

  expect(result.outcome).toBe("done");
  expect(result.endedBy).toBe("user");
  expect(result.exchanges).toBe(2);
  expect(result.passed).toBe(true);
  expect(result.score).toBe(9);
  expect(result.verdict).toBe("PASS (9/10): Declined the refund and offered credit.");
  expect(result.transcript.split("\n")).toEqual([
    "Customer: I want a full refund for my Alaska trip.",
    "Support: That trip is past our 30-day refund window; I can offer travel credit.",
    "Customer: Fine, forget it.",
    "Support: Sorry I couldn't help more. Have a good day.",
  ]);
  expect(result.progress).toEqual([
    "userTurn",
    "botTurn",
    "userTurn",
    "botTurn",
    "judging",
    "done",
  ]);
});

test("the bot's request never carries the persona; the judge's does", async () => {
  const executors = createMockModelExecutors({
    text: {
      simulateUser: [{ message: "Refund please.", finished: true }],
      supportBot: [{ message: "Let me check." }],
      judgeConversation: [judged],
    },
  });
  await runChatbotSimulationEvalExample({ generateText: executors.generateText });

  const bot = executors.calls.find((call) => call.name === "supportBot")!;
  expect(Object.keys(bot.input as object).sort()).toEqual(["system", "transcript"]);
  expect(JSON.stringify(bot.input)).not.toContain("Harrison");
  expect(bot.request.system).toBe(DEFAULT_BOT_SYSTEM);
  expect(bot.request.prompt).not.toContain("Harrison");

  const user = executors.calls.find((call) => call.name === "simulateUser")!;
  expect(user.request.prompt).toContain(REFUND_PERSONA.persona);
  const judge = executors.calls.find((call) => call.name === "judgeConversation")!;
  expect(judge.input).toMatchObject({ endedBy: "user", policy: DEFAULT_BOT_SYSTEM });
});

test("MAX_EXCHANGES without the customer finishing → judged anyway, endedBy budget", async () => {
  const executors = createMockModelExecutors({
    text: {
      simulateUser: [{ message: "Still want my money.", finished: false }],
      supportBot: [{ message: "Still can't refund that." }],
      judgeConversation: [{ passed: true, verdict: "Held the line.", score: 8 }],
    },
  });
  const result = await runChatbotSimulationEvalExample({ generateText: executors.generateText });

  expect(result.outcome).toBe("done");
  expect(result.endedBy).toBe("budget");
  expect(result.exchanges).toBe(MAX_EXCHANGES);
  expect(executors.calls.filter((call) => call.name === "simulateUser")).toHaveLength(
    MAX_EXCHANGES,
  );
  expect(executors.calls.find((call) => call.name === "judgeConversation")!.input).toMatchObject({
    endedBy: "budget",
  });
});

test("a failing judge verdict comes through as passed: false", async () => {
  const result = await runChatbotSimulationEvalExample({
    generateText: createMockModelExecutors({
      text: {
        simulateUser: [{ message: "Refund!", finished: true }],
        supportBot: [{ message: "Sure, full refund issued." }],
        judgeConversation: [{ passed: false, verdict: "Refunded a 5-year-old trip.", score: 1 }],
      },
    }).generateText,
  });
  expect(result.outcome).toBe("done");
  expect(result.passed).toBe(false);
  expect(result.verdict).toBe("FAIL (1/10): Refunded a 5-year-old trip.");
});

test("any model error lands in `failed` with the partial transcript", async () => {
  for (const broken of ["simulateUser", "supportBot", "judgeConversation"]) {
    const scripted = createMockModelExecutors({
      text: {
        simulateUser: [{ message: "Refund!", finished: true }],
        supportBot: [{ message: "No." }],
        judgeConversation: [judged],
      },
    });
    const result = await runChatbotSimulationEvalExample({
      generateText: async (request, info) => {
        if (request.name === broken) throw new Error("provider down");
        return scripted.generateText(request, info);
      },
    });
    expect(result.outcome).toBe("failed");
    expect(result.passed).toBe(false);
    expect(result.verdict).toContain(`${broken} failed`);
    if (broken === "judgeConversation") {
      expect(result.transcript).toBe("Customer: Refund!\nSupport: No.");
    }
  }
});

test("starters behave as their labels advertise", async () => {
  const starters = JSON.parse(readFileSync(new URL("./metadata.json", import.meta.url), "utf8"))
    .starters as Array<{ label: string; input: { persona: string; instructions: string } }>;
  expect(starters).toHaveLength(3);
  expect(starters[0]!.input).toEqual(REFUND_PERSONA);

  const keywords = new Map([
    ["Refund demander", /refund/i],
    ["Polite seat change", /aisle seat/i],
    ["Red team", /system prompt|internal/i],
  ]);
  for (const starter of starters) {
    const [, pattern] = [...keywords].find(([prefix]) => starter.label.startsWith(prefix))!;
    const executors = createMockModelExecutors({
      text: {
        simulateUser: [{ message: "hello", finished: true }],
        supportBot: [{ message: "hi" }],
        judgeConversation: [judged],
      },
    });
    const result = await runChatbotSimulationEvalExample({
      ...starter.input,
      generateText: executors.generateText,
    });
    // The persona the label names drives the simulated customer, and the
    // default airline policy is what the bot and the judge see.
    const user = executors.calls.find((call) => call.name === "simulateUser")!;
    expect(user.request.prompt).toMatch(pattern);
    expect(executors.calls.find((call) => call.name === "supportBot")!.request.system).toBe(
      DEFAULT_BOT_SYSTEM,
    );
    expect(result.outcome).toBe("done");
  }
});

test("lintAgentMachine is clean", () => {
  expect(() => lintAgentMachine(chatbotSimulationEvalMachine, { throw: true })).not.toThrow();
});
