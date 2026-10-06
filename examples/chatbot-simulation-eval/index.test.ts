import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { lintAgentMachine } from "@statelyai/agent/testing";
import { createMockJudge } from "../mock-judge.js";
import { createMockModelExecutors } from "../mock-model.js";
import {
  DEFAULT_BOT_SYSTEM,
  MAX_EXCHANGES,
  PASS_THRESHOLD,
  QUALITY_LEVELS,
  REFUND_PERSONA,
  chatbotSimulationEvalMachine,
  runChatbotSimulationEvalExample,
} from "./index.js";

/** The Jev judge: followed the policy, quality level 4 of 0-5 (→ 8/10). */
const judged = () => createMockJudge({ followedPolicy: true, quality: 4 });

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
    },
  });
  const result = await runChatbotSimulationEvalExample({
    generateText: executors.generateText,
    judge: judged().model,
  });

  expect(result.outcome).toBe("done");
  expect(result.endedBy).toBe("user");
  expect(result.exchanges).toBe(2);
  expect(result.passed).toBe(true);
  expect(result.score).toBe(8);
  expect(result.verdict).toBe(`PASS (8/10): ${QUALITY_LEVELS[4]}`);
  // One paragraph per turn: a blank line between turns, so Markdown renderers
  // don't collapse the conversation into one run-on paragraph.
  expect(result.transcript.split("\n\n")).toEqual([
    "Customer: I want a full refund for my Alaska trip.",
    "Support: That trip is past our 30-day refund window; I can offer travel credit.",
    "Customer: Fine, forget it.",
    "Support: Sorry I couldn't help more. Have a good day.",
  ]);
  expect(result.transcript).not.toMatch(/[^\n]\n[^\n]/);
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
    },
  });
  const jev = judged();
  await runChatbotSimulationEvalExample({
    generateText: executors.generateText,
    judge: jev.model,
  });

  const bot = executors.calls.find((call) => call.name === "supportBot")!;
  expect(Object.keys(bot.input as object).sort()).toEqual(["system", "transcript"]);
  expect(JSON.stringify(bot.input)).not.toContain("Harrison");
  expect(bot.request.system).toBe(DEFAULT_BOT_SYSTEM);
  expect(bot.request.prompt).not.toContain("Harrison");

  const user = executors.calls.find((call) => call.name === "simulateUser")!;
  expect(user.request.prompt).toContain(REFUND_PERSONA.persona);
  expect(jev.calls[0]!.state).toMatchObject({
    endedBy: "user",
    policy: DEFAULT_BOT_SYSTEM,
    persona: REFUND_PERSONA.persona,
  });
});

test("MAX_EXCHANGES without the customer finishing → judged anyway, endedBy budget", async () => {
  const executors = createMockModelExecutors({
    text: {
      simulateUser: [{ message: "Still want my money.", finished: false }],
      supportBot: [{ message: "Still can't refund that." }],
    },
  });
  const jev = judged();
  const result = await runChatbotSimulationEvalExample({
    generateText: executors.generateText,
    judge: jev.model,
  });

  expect(result.outcome).toBe("done");
  expect(result.endedBy).toBe("budget");
  expect(result.exchanges).toBe(MAX_EXCHANGES);
  expect(executors.calls.filter((call) => call.name === "simulateUser")).toHaveLength(
    MAX_EXCHANGES,
  );
  expect(jev.calls[0]!.state).toMatchObject({ endedBy: "budget" });
});

test("a failing judge verdict comes through as passed: false", async () => {
  const result = await runChatbotSimulationEvalExample({
    generateText: createMockModelExecutors({
      text: {
        simulateUser: [{ message: "Refund!", finished: true }],
        supportBot: [{ message: "Sure, full refund issued." }],
      },
    }).generateText,
    judge: createMockJudge({ followedPolicy: false, quality: 0 }).model,
  });
  expect(result.outcome).toBe("done");
  expect(result.passed).toBe(false);
  expect(result.verdict).toBe(`FAIL (0/10): ${QUALITY_LEVELS[0]}`);
});

test("any model error lands in `failed` with the partial transcript", async () => {
  for (const broken of ["simulateUser", "supportBot", "judgeConversation"]) {
    const scripted = createMockModelExecutors({
      text: {
        simulateUser: [{ message: "Refund!", finished: true }],
        supportBot: [{ message: "No." }],
      },
    });
    const result = await runChatbotSimulationEvalExample({
      generateText: async (request, info) => {
        if (request.name === broken) throw new Error("provider down");
        return scripted.generateText(request, info);
      },
      judge: createMockJudge({
        followedPolicy: () => {
          if (broken === "judgeConversation") throw new Error("provider down");
          return true;
        },
        quality: 4,
      }).model,
    });
    expect(result.outcome).toBe("failed");
    expect(result.passed).toBe(false);
    expect(result.verdict).toContain(`${broken} failed`);
    if (broken === "judgeConversation") {
      expect(result.transcript).toBe("Customer: Refund!\n\nSupport: No.");
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
      },
    });
    const result = await runChatbotSimulationEvalExample({
      ...starter.input,
      generateText: executors.generateText,
      judge: judged().model,
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

test("the judge asks Jev a policy boolean question and a quality score in one call; PASS_THRESHOLD decides passed", async () => {
  const run = (followedPolicy: number) => {
    const jev = createMockJudge({ followedPolicy, quality: 3 });
    const result = runChatbotSimulationEvalExample({
      generateText: createMockModelExecutors({
        text: {
          simulateUser: [{ message: "Refund!", finished: true }],
          supportBot: [{ message: "Outside the window; I can offer credit." }],
        },
      }).generateText,
      judge: jev.model,
    });
    return { jev, result };
  };

  const above = run(PASS_THRESHOLD + 0.05);
  const aboveResult = await above.result;
  expect(above.jev.calls).toHaveLength(1);
  const call = above.jev.calls[0]!;
  expect((call.state as { transcript: unknown }).transcript).toEqual([
    { role: "user", text: "Refund!" },
    { role: "bot", text: "Outside the window; I can offer credit." },
  ]);
  expect(Object.fromEntries(Object.entries(call.questions).map(([k, q]) => [k, q.type]))).toEqual({
    followedPolicy: "boolean",
    quality: "score",
  });
  expect(aboveResult).toMatchObject({ passed: true, score: 6 });

  const below = await run(PASS_THRESHOLD - 0.05).result;
  expect(below).toMatchObject({ passed: false, score: 6 });
  expect(below.verdict).toBe(`FAIL (6/10): ${QUALITY_LEVELS[3]}`);
});

test("lintAgentMachine is clean", () => {
  expect(() => lintAgentMachine(chatbotSimulationEvalMachine, { throw: true })).not.toThrow();
});
