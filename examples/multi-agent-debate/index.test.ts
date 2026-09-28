import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { type AgentTextRequest } from "@statelyai/agent";
import { lintAgentMachine } from "@statelyai/agent/testing";
import { createMockJudge } from "../mock-judge.js";
import { createMockModelExecutors } from "../mock-model.js";
import {
  CASE_LEVELS,
  MAX_ROUNDS,
  multiAgentDebateMachine,
  plainArgument,
  runMultiAgentDebateExample,
} from "./index.js";

/** Each speaker names its side and round, read from the request input. */
function speaker(side: string) {
  return (request: AgentTextRequest) => ({
    argument: `${side} point for round ${(request.input as { round: number }).round}`,
  });
}

/** The speakers, mocked by request name. */
function scripted() {
  return createMockModelExecutors({
    text: { argueFor: speaker("pro"), argueAgainst: speaker("con") },
  });
}

/** The Jev judge: each side's case level 0-5 (→ 0-10 in steps of 2). */
function judge(proCase = 4, conCase = 3) {
  return createMockJudge({ proCase, conCase });
}

test("two rounds alternate pro/con, then the judge decides", async () => {
  const executors = scripted();
  const jev = judge();
  const result = await runMultiAgentDebateExample({
    motion: "Agent control flow belongs in code.",
    rounds: 2,
    generateText: executors.generateText,
    judge: jev.model,
  });
  expect(result.progress).toEqual([
    "proSpeaking",
    "conSpeaking",
    "proSpeaking",
    "conSpeaking",
    "judging",
    "done",
  ]);
  expect(executors.calls.map((call) => call.name)).toEqual([
    "argueFor",
    "argueAgainst",
    "argueFor",
    "argueAgainst",
  ]);
  expect(jev.calls).toHaveLength(1);
  expect(result.rounds).toBe(2);
  expect(result.winner).toBe("pro");
  expect(result.scores).toEqual({ pro: 8, con: 6 });
  expect(result.verdict).toBe(
    `Winner: pro — Pro 8/10: ${CASE_LEVELS[4]} Con 6/10: ${CASE_LEVELS[3]}`,
  );
  expect(result.transcript.split("\n\n")).toEqual([
    "Round 1 — PRO: pro point for round 1",
    "Round 1 — CON: con point for round 1",
    "Round 2 — PRO: pro point for round 2",
    "Round 2 — CON: con point for round 2",
  ]);
});

test("rounds defaults to 2 and the judge sees the whole transcript", async () => {
  const jev = judge(3, 3);
  const result = await runMultiAgentDebateExample({
    generateText: scripted().generateText,
    judge: jev.model,
  });
  expect(result.rounds).toBe(2);
  expect(result.winner).toBe("draw");
  expect(result.verdict).toMatch(/^Draw — Pro 6\/10: /);
  const transcript = (jev.calls[0]!.state as { transcript: Array<{ side: string; round: number }> })
    .transcript;
  expect(transcript).toHaveLength(4);
  expect(transcript.at(-1)).toMatchObject({ side: "con", round: 2 });
});

test("rounds above MAX_ROUNDS are rejected at the input boundary", async () => {
  await expect(
    runMultiAgentDebateExample({
      rounds: MAX_ROUNDS + 1,
      generateText: scripted().generateText,
    }),
  ).rejects.toThrow();
});

test("a speaker failure ends in `failed` with the transcript so far", async () => {
  const result = await runMultiAgentDebateExample({
    rounds: 2,
    generateText: createMockModelExecutors({
      text: {
        argueFor: speaker("pro"),
        argueAgainst: [
          { argument: "con point for round 1" },
          () => {
            throw new Error("rate limited");
          },
        ],
      },
    }).generateText,
  });
  expect(result.finalState).toBe("failed");
  expect(result.winner).toBeNull();
  expect(result.verdict).toContain("argueAgainst failed");
  expect(result.transcript).toContain("Round 2 — PRO: pro point for round 2");
  expect(result.progress).not.toContain("judging");
});

test("a judge failure ends in `failed`, not a verdict", async () => {
  const result = await runMultiAgentDebateExample({
    rounds: 1,
    generateText: createMockModelExecutors({
      text: {
        argueFor: speaker("pro"),
        argueAgainst: speaker("con"),
      },
    }).generateText,
    judge: createMockJudge({
      proCase: () => {
        throw new Error("judge offline");
      },
      "*": 0,
    }).model,
  });
  expect(result.finalState).toBe("failed");
  expect(result.verdict).toContain("judgeDebate failed");
  expect(result.transcript.split("\n\n")).toHaveLength(2);
});

test("starters behave as their labels advertise", async () => {
  const starters = JSON.parse(readFileSync(new URL("./metadata.json", import.meta.url), "utf8"))
    .starters as Array<{ label: string; input: { motion: string; rounds: number } }>;
  expect(starters).toHaveLength(3);
  for (const starter of starters) {
    const result = await runMultiAgentDebateExample({
      ...starter.input,
      generateText: scripted().generateText,
      judge: judge().model,
    });
    expect(result.finalState).toBe("done");
    expect(result.rounds).toBe(starter.input.rounds);
    expect(result.progress.filter((state) => state === "proSpeaking")).toHaveLength(
      starter.input.rounds,
    );
    if (starter.label.includes("MAX_ROUNDS")) expect(starter.input.rounds).toBe(MAX_ROUNDS);
    if (starter.label.startsWith("One round")) expect(starter.input.rounds).toBe(1);
    if (starter.label.startsWith("Two rounds")) expect(starter.input.rounds).toBe(2);
  }
});

test("the winner is derived from the scores, so the two can never disagree", async () => {
  // The QA run had "Winner: pro" next to {pro: 6, con: 7}: a separate winner
  // question disagreed with the scores. Every pair of levels must agree now.
  for (let pro = 0; pro < CASE_LEVELS.length; pro++) {
    for (let con = 0; con < CASE_LEVELS.length; con++) {
      const result = await runMultiAgentDebateExample({
        rounds: 1,
        generateText: scripted().generateText,
        judge: judge(pro, con).model,
      });
      const { scores, winner } = result;
      const expected =
        scores!.pro > scores!.con ? "pro" : scores!.con > scores!.pro ? "con" : "draw";
      expect(winner).toBe(expected);
    }
  }
});

test("each speaker's stance is restated in its prompt on every round", async () => {
  const executors = scripted();
  await runMultiAgentDebateExample({
    rounds: MAX_ROUNDS,
    generateText: executors.generateText,
    judge: judge().model,
  });

  const prompts = (name: string) =>
    executors.calls.filter((call) => call.name === name).map((call) => String(call.request.prompt));
  expect(prompts("argueFor")).toHaveLength(MAX_ROUNDS);
  expect(prompts("argueAgainst")).toHaveLength(MAX_ROUNDS);
  // Last line of every turn's prompt pins the side, even in later rounds
  // whose transcript is full of the other side's points.
  for (const prompt of prompts("argueFor")) {
    expect(prompt.split("\n").at(-1)).toMatch(/^Your side: FOR the motion\./);
  }
  for (const prompt of prompts("argueAgainst")) {
    expect(prompt.split("\n").at(-1)).toMatch(/^Your side: AGAINST the motion\./);
  }
});

test("turns read as unlabeled prose: the prompt asks for it, and leftover labels are dropped", async () => {
  // A live speaker answered "Make one new point and rebut…" with labeled parts:
  // "… New point: putting control flow in code …", "Rebuttal: the proposition …".
  const executors = createMockModelExecutors({
    text: {
      argueFor: {
        argument: "New point: code is testable. Rebuttal: flexibility is not precision.",
      },
      argueAgainst: { argument: "Prompts adapt faster. new point: they need no redeploy." },
    },
  });
  const result = await runMultiAgentDebateExample({
    rounds: 1,
    generateText: executors.generateText,
    judge: judge().model,
  });

  expect(result.transcript).toContain("PRO: Code is testable. Flexibility is not precision.");
  expect(result.transcript).toContain("CON: Prompts adapt faster. They need no redeploy.");
  expect(result.transcript).not.toMatch(/new point|rebuttal/i);
  for (const call of executors.calls) {
    expect(call.request.system).toMatch(/Do not label the parts/);
    expect(call.request.system).not.toMatch(/Make one new point/);
  }
  // Ordinary colons and lower-case words after abbreviations are left alone.
  expect(plainArgument("The point: e.g. prompts drift.")).toBe("The point: e.g. prompts drift.");
});

test("the judge asks Jev one score per side in one call over the transcript", async () => {
  const jev = judge(2, 5);
  const result = await runMultiAgentDebateExample({
    motion: "Cities should ban cars.",
    rounds: 1,
    generateText: scripted().generateText,
    judge: jev.model,
  });

  expect(jev.calls).toHaveLength(1);
  const call = jev.calls[0]!;
  expect(call.state).toEqual({
    motion: "Cities should ban cars.",
    transcript: [
      { side: "pro", round: 1, argument: "pro point for round 1" },
      { side: "con", round: 1, argument: "con point for round 1" },
    ],
  });
  expect(Object.fromEntries(Object.entries(call.questions).map(([k, q]) => [k, q.type]))).toEqual({
    proCase: "score",
    conCase: "score",
  });
  expect(result).toMatchObject({ winner: "con", scores: { pro: 4, con: 10 } });
});

test("machine is structurally sound", () => {
  lintAgentMachine(multiAgentDebateMachine, { throw: true });
});
