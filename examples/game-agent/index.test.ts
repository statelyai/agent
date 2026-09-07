import { describe, expect, test } from "vitest";
import { getInteraction, type AgentDecisionExecutor } from "@statelyai/agent";
import {
  renderHistory,
  renderNotice,
  rpsMachine,
  runRpsExample,
  toThrowEvent,
  type HumanThrowEvent,
} from "./index.js";

/** The model always throws rock, so scripted paper throws win every round. */
const alwaysRock: AgentDecisionExecutor = async () => ({ event: { type: "THROW_ROCK" } });

describe("rock-paper-scissors machine", () => {
  test("the human drives each round through the idle-resume loop", async () => {
    const idleLabels: string[] = [];
    const prompts: string[] = [];
    const decide: AgentDecisionExecutor = async (request) => {
      prompts.push(request.prompt ?? "");
      return { event: { type: "THROW_ROCK" } };
    };

    const output = await runRpsExample({
      input: { targetWins: 3 },
      decide,
      humanThrows: [{ type: "HUMAN_PAPER" }, { type: "HUMAN_PAPER" }, { type: "HUMAN_PAPER" }],
      onNotice: (notice) => idleLabels.push(notice),
    });

    expect(output.outcome).toBe("won");
    expect(output.playerScore).toBe(3);
    expect(output.opponentScore).toBe(0);
    expect(output.history).toHaveLength(3);

    // One idle settle per throw, and the label is derived from the log.
    expect(idleLabels).toHaveLength(3);
    expect(idleLabels[0]).toContain("First to 3 wins.");
    expect(idleLabels[2]).toContain("Score: you 2, agent 0.");

    // The lesson: each decide prompt renders the saved event log back.
    expect(prompts[0]).toContain("No rounds played yet.");
    expect(prompts[2]).toContain("Round 2: human threw paper");

    // Readable match recap.
    expect(output.summary).toContain("Round 1: you paper vs agent rock — you win");
    expect(output.summary).toContain("You won the match 3-0.");
  });

  test("the human can lose the match too", async () => {
    const output = await runRpsExample({
      input: { targetWins: 2 },
      decide: alwaysRock,
      humanThrows: [{ type: "HUMAN_SCISSORS" }, { type: "HUMAN_SCISSORS" }],
    });

    expect(output.outcome).toBe("lost");
    expect(output.summary).toContain("You lost the match 0-2.");
  });

  test("ties do not score, so the match runs longer", async () => {
    const output = await runRpsExample({
      input: { targetWins: 1 },
      decide: alwaysRock,
      humanThrows: [{ type: "HUMAN_ROCK" }, { type: "HUMAN_PAPER" }],
    });

    expect(output.history[0]?.result).toBe("tie");
    expect(output.outcome).toBe("won");
  });

  test("the idle state advertises the three throws as buttons", async () => {
    const seen: string[] = [];
    await runRpsExample({
      input: { targetWins: 1 },
      decide: alwaysRock,
      nextHumanThrow: (snapshot): HumanThrowEvent => {
        const interaction = getInteraction(snapshot);
        seen.push(...(interaction?.events.map(({ type }) => type) ?? []));
        return { type: "HUMAN_PAPER" };
      },
    });

    expect(seen).toEqual(["HUMAN_ROCK", "HUMAN_PAPER", "HUMAN_SCISSORS"]);
  });

  test("machine, helpers", () => {
    expect(rpsMachine.id).toBe("rps-event-log");
    expect(renderHistory([])).toBe("No rounds played yet.");
    expect(toThrowEvent("Paper")).toEqual({ type: "HUMAN_PAPER" });
    expect(toThrowEvent("s")).toEqual({ type: "HUMAN_SCISSORS" });
    expect(toThrowEvent("whatever")).toEqual({ type: "HUMAN_ROCK" });
    expect(renderNotice({ targetWins: 3, playerScore: 0, opponentScore: 0, history: [] })).toBe(
      "First to 3 wins. Throw something.",
    );
  });
});
