import { describe, expect, test } from "vitest";
import type { AgentDecisionExecutor, AgentRequestExecutor } from "@statelyai/agent";
import { runAiSdkGameTurn } from "./index.js";

/**
 * Mock executor set for one game turn. `decide` picks a fixed move by its
 * event `type` (validated against the machine's event schemas by
 * `resolveDecision`); `summarizeTurn` returns canned HP totals. Both record
 * their calls so tests can assert the host drove decision → text in order.
 */
function createGameExecutors(opts: {
  move: "ATTACK" | "DEFEND" | "HEAL" | "FLEE";
  summary?: { summary: string; playerHp: number; enemyHp: number };
}) {
  const calls: string[] = [];

  const decide: AgentDecisionExecutor = async (request) => {
    calls.push("decide");
    const chosen = request.events.find((event) => event.type === opts.move);
    if (!chosen) {
      throw new Error(`mock decide: '${opts.move}' is not a legal move here.`);
    }
    // HEAL carries a payload; the machine's event schema validates it.
    return { event: opts.move === "HEAL" ? { type: "HEAL", amount: 4 } : { type: opts.move } };
  };

  const generateText: AgentRequestExecutor = async () => {
    calls.push("summarize");
    return {
      output: opts.summary ?? { summary: "The hero strikes.", playerHp: 20, enemyHp: 9 },
    };
  };

  return { executors: { generateText, decide }, calls };
}

describe("ai-sdk-game-host", () => {
  test("ATTACK move drives decision → summary and ends the turn 'continue'", async () => {
    const { executors, calls } = createGameExecutors({
      move: "ATTACK",
      summary: { summary: "The hero strikes the goblin.", playerHp: 20, enemyHp: 9 },
    });
    const states: unknown[] = [];

    const output = await runAiSdkGameTurn(
      { playerHp: 20, enemyHp: 15 },
      (value) => states.push(value),
      executors,
    );

    expect(output).toEqual({
      outcome: "continue",
      summary: "The hero strikes the goblin.",
      playerHp: 20,
      enemyHp: 9,
    });
    // Host owned the loop: it chose a move, then narrated the turn, in order.
    expect(calls).toEqual(["decide", "summarize"]);
    // The step callback saw the machine pass through choosing → summarizing.
    expect(states).toContain("choosingMove");
    expect(states).toContain("summarizing");
  });

  test("summary reporting enemyHp <= 0 wins the turn", async () => {
    const { executors } = createGameExecutors({
      move: "ATTACK",
      summary: { summary: "The goblin falls.", playerHp: 18, enemyHp: 0 },
    });

    const output = await runAiSdkGameTurn({ playerHp: 18, enemyHp: 4 }, undefined, executors);

    expect(output).toEqual({
      outcome: "won",
      summary: "The goblin falls.",
      playerHp: 18,
      enemyHp: 0,
    });
  });

  test("FLEE ends the turn without a summary request", async () => {
    const { executors, calls } = createGameExecutors({ move: "FLEE" });

    const output = await runAiSdkGameTurn({ playerHp: 20, enemyHp: 15 }, undefined, executors);

    expect(output).toBeDefined();
    expect(output?.outcome).toBe("fled");
    expect(output?.summary).toBe("You fled the encounter.");
    // Fleeing skips summarizing entirely.
    expect(calls).toEqual(["decide"]);
    expect(calls).not.toContain("summarize");
  });
});
