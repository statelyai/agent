import { describe, expect, test } from "vitest";
import { createAgentActor, replay } from "@statelyai/agent";
import type { AgentRequestExecutor } from "@statelyai/agent";
import { idleLabel, runSession, sessionQuizMachine } from "./index.js";

/** Scripted host: one trivia question, graded against a fixed expected answer. */
function scriptedExecutor(): AgentRequestExecutor {
  return async (request) => {
    if (request.system?.includes("Grade a trivia answer")) {
      const answer = (request.prompt ?? "").match(/Answer: (.*)/)?.[1] ?? "";
      return {
        output: {
          correct: /mars/i.test(answer),
          expected: "Mars",
          explanation: "Mars is the fourth planet from the Sun.",
        },
      };
    }
    return { output: "Which planet is fourth from the Sun?" };
  };
}

/** Answer once, then read the label the session settles idle on. */
async function answerOnce(text: string) {
  const session = createAgentActor(sessionQuizMachine, {
    input: {},
    executors: { generateText: scriptedExecutor() },
  });
  await session.settled();
  session.actor.send({ type: "ANSWER", text });
  await session.settled();
  return {
    label: idleLabel(session.actor.getSnapshot()),
    context: session.actor.getSnapshot().context,
  };
}

describe("session-actor", () => {
  test("one live actor spans idle settles; the log replays and usage aggregates", async () => {
    const { session, result } = await runSession();
    expect(result.status).toBe("done");
    expect(result.status === "done" ? result.output : undefined).toEqual({
      rounds: 1,
      correct: 1,
    });

    // Three model calls (two questions plus one grading), aggregated tokens.
    expect(session.usage().modelCalls).toBe(3);
    expect(session.usage().totalTokens).toBe(36);

    // The session-wide log replays deterministically to the same final state.
    const replayed = replay(sessionQuizMachine, [...session.events]);
    expect(replayed.snapshot.status).toBe("done");
    expect(replayed.snapshot.output).toEqual({ rounds: 1, correct: 1 });
  });

  test("a correct answer is graded before the next question is shown", async () => {
    const { label, context } = await answerOnce("Mars");

    expect(context.correct).toBe(1);
    expect(context.lastGrade).toContain("Correct —");
    // The verdict leads the idle label, above the next question.
    expect(label).toContain("Correct —");
    expect(label).toContain("the answer");
    expect(label).toContain("Mars");
    expect(label).toContain("Which planet is fourth from the Sun?");
    expect(label.indexOf("Correct")).toBeLessThan(label.indexOf("Which planet"));
  });

  test("a wrong answer names the expected answer instead of silently moving on", async () => {
    const { label, context } = await answerOnce("Jupiter");

    expect(context.correct).toBe(0);
    expect(context.rounds).toBe(1);
    expect(label).toContain("Incorrect —");
    // Correctness and the expected answer are both visible.
    expect(label).toContain("Mars");
    expect(label).toContain("Mars is the fourth planet from the Sun.");
    expect(label).toContain("Which planet is fourth from the Sun?");
  });
});
