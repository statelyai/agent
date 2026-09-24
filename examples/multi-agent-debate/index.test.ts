import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { type AgentTextRequest } from "@statelyai/agent";
import { lintAgentMachine } from "@statelyai/agent/testing";
import { createMockModelExecutors } from "../mock-model.js";
import { MAX_ROUNDS, multiAgentDebateMachine, runMultiAgentDebateExample } from "./index.js";

/** Each speaker names its side and round, read from the request input. */
function speaker(side: string) {
  return (request: AgentTextRequest) => ({
    argument: `${side} point for round ${(request.input as { round: number }).round}`,
  });
}

function scripted(
  judge: unknown = { winner: "pro", reasoning: "Sharper rebuttals.", scores: { pro: 8, con: 6 } },
) {
  return createMockModelExecutors({
    text: { argueFor: speaker("pro"), argueAgainst: speaker("con"), judgeDebate: [judge] },
  });
}

test("two rounds alternate pro/con, then the judge decides", async () => {
  const executors = scripted();
  const result = await runMultiAgentDebateExample({
    motion: "Agent control flow belongs in code.",
    rounds: 2,
    generateText: executors.generateText,
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
    "judgeDebate",
  ]);
  expect(result.rounds).toBe(2);
  expect(result.winner).toBe("pro");
  expect(result.scores).toEqual({ pro: 8, con: 6 });
  expect(result.verdict).toBe("Winner: pro — Sharper rebuttals.");
  expect(result.transcript.split("\n\n")).toEqual([
    "Round 1 — PRO: pro point for round 1",
    "Round 1 — CON: con point for round 1",
    "Round 2 — PRO: pro point for round 2",
    "Round 2 — CON: con point for round 2",
  ]);
});

test("rounds defaults to 2 and the judge sees the whole transcript", async () => {
  const executors = scripted({ winner: "draw", reasoning: "Even.", scores: { pro: 5, con: 5 } });
  const result = await runMultiAgentDebateExample({ generateText: executors.generateText });
  expect(result.rounds).toBe(2);
  expect(result.winner).toBe("draw");
  const judgeCall = executors.calls.find((call) => call.name === "judgeDebate")!;
  expect((judgeCall.input as { transcript: string }).transcript).toContain("Round 2 — CON");
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
        judgeDebate: () => {
          throw new Error("judge offline");
        },
      },
    }).generateText,
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

test("machine is structurally sound", () => {
  lintAgentMachine(multiAgentDebateMachine, { throw: true });
});
