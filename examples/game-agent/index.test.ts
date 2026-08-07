import { describe, expect, test } from "vitest";
import {
  getStateMeta,
  runAgent,
  type AgentDecisionExecutor,
  type AgentRequestExecutor,
  type ChosenEvent,
} from "@statelyai/agent";
import {
  gameMachine,
  renderHistory,
  resolveInteractionLabel,
  rpsMachine,
  runRpsExample,
  toThrowEvent,
  type HumanThrowEvent,
} from "./index.js";

/** Always attacks; records the prompts so `allowedEvents` can be inspected. */
function createMockMoveChooser(move: ChosenEvent = { type: "ATTACK", target: "goblin" }) {
  const requests: { prompt?: string; allowedEvents?: readonly string[] }[] = [];
  const decide: AgentDecisionExecutor = async (request) => {
    requests.push({
      prompt: request.prompt,
      allowedEvents: request.events?.map((event) => event.type),
    });
    return { event: move };
  };
  return { decide, requests };
}

const mockSummarizer: AgentRequestExecutor = async () => ({
  output: { summary: "The goblin staggers back, bleeding.", playerHp: 20, enemyHp: 9 },
});

describe("game-agent combat machine", () => {
  test("narrates the turn into a readable summary", async () => {
    const chooser = createMockMoveChooser();
    const result = await runAgent(gameMachine, {
      input: { playerHp: 20, enemyHp: 15 },
      executors: { decide: chooser.decide, generateText: mockSummarizer },
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") return;

    expect(result.output.outcome).toBe("continue");
    // Readable narration, not a bare data dump: one line per beat.
    expect(result.output.summary).toContain("You face a goblin");
    expect(result.output.summary).toContain("You attack the goblin for 6 (goblin 15 → 9).");
    expect(result.output.summary).toContain("The goblin staggers back, bleeding.");
    expect(result.output.summary).toContain("The fight goes on.");
    expect(result.output.summary.split("\n").length).toBeGreaterThan(3);
  });

  test("allowedEvents widen to include HEAL only at low HP", async () => {
    const healthy = createMockMoveChooser();
    await runAgent(gameMachine, {
      input: { playerHp: 20, enemyHp: 15 },
      executors: { decide: healthy.decide, generateText: mockSummarizer },
    });
    expect(healthy.requests[0]?.allowedEvents).not.toContain("HEAL");

    const hurt = createMockMoveChooser();
    await runAgent(gameMachine, {
      input: { playerHp: 5, enemyHp: 15 },
      executors: { decide: hurt.decide, generateText: mockSummarizer },
    });
    expect(hurt.requests[0]?.allowedEvents).toContain("HEAL");
  });
});

/** The model always throws rock, so scripted paper throws win every round. */
const alwaysRock: AgentDecisionExecutor = async () => ({ event: { type: "THROW_ROCK" } });

describe("game-agent rock-paper-scissors machine", () => {
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

    // One idle settle per throw, and the label resolves `{notice}` from context.
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
        const interaction = getStateMeta(snapshot).interaction;
        seen.push(...Object.keys(interaction?.events ?? {}));
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
    expect(resolveInteractionLabel("{notice} go", { notice: "hi" })).toBe("hi go");
  });
});
