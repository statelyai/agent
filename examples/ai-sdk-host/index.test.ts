import { describe, expect, test } from "vitest";
import {
  runAgent,
  type AgentDecisionExecutor,
  type AgentRequestExecutor,
  type ChosenEvent,
} from "@statelyai/agent";
import { gameMachine, runAiSdkGameTurn, runAiSdkHostExample } from "./index.js";

/** Always plays one fixed move; records the requests so `allowedEvents` can be
 * inspected. */
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

/** The narrator returns prose only — it has no way to touch HP. */
const mockSummarizer: AgentRequestExecutor = async (request) => {
  // Routed on the request's name, so a second text request in the machine
  // could never be answered by this canned summary.
  if (request.name !== "summarizeTurn") {
    throw new Error(`mock generateText: no route for request '${request.name}'.`);
  }
  return { output: { summary: "The goblin staggers back, bleeding." } };
};

describe("combat machine", () => {
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
    // The machine, not the narrator, resolved the goblin's counter.
    expect(result.output.summary).toContain("The goblin hits back for 4 (you 20 → 16).");
    expect(result.output.summary).toContain("The goblin staggers back, bleeding.");
    expect(result.output.summary).toContain("The fight goes on.");
    expect(result.output.playerHp).toBe(16);
    expect(result.output.enemyHp).toBe(9);
    expect(result.output.summary.split("\n").length).toBeGreaterThan(3);
  });

  test("a raised guard halves the counter, and that is a state, not a flag", async () => {
    const chooser = createMockMoveChooser({ type: "DEFEND" });
    const result = await runAgent(gameMachine, {
      input: { playerHp: 20, enemyHp: 15 },
      executors: { decide: chooser.decide, generateText: mockSummarizer },
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") return;
    expect(result.output.summary).toContain("The goblin hits back for 2 (you 20 → 18).");
    expect(result.output.playerHp).toBe(18);
  });

  test("a downed goblin never gets a counter-attack", async () => {
    const chooser = createMockMoveChooser();
    const result = await runAgent(gameMachine, {
      input: { playerHp: 20, enemyHp: 6 },
      executors: { decide: chooser.decide, generateText: mockSummarizer },
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") return;
    expect(result.output.outcome).toBe("won");
    expect(result.output.playerHp).toBe(20);
    expect(result.output.summary).not.toContain("hits back");
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

/**
 * Mock executor set for one hosted turn. `decide` picks a fixed move by its
 * event `type` (validated against the machine's event schemas by
 * `resolveDecision`); `generateText` returns canned NARRATION only — HP is the
 * machine's to compute. Both record their calls so tests can assert the host
 * drove decision → text in order.
 */
function createGameExecutors(opts: {
  move: "ATTACK" | "DEFEND" | "HEAL" | "FLEE";
  summary?: { summary: string };
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

  const generateText: AgentRequestExecutor = async (request) => {
    if (request.name !== "summarizeTurn") {
      throw new Error(`mock generateText: no route for request '${request.name}'.`);
    }
    calls.push("summarize");
    return { output: opts.summary ?? { summary: "The hero strikes." } };
  };

  return { executors: { generateText, decide }, calls };
}

describe("ai-sdk host", () => {
  test("ATTACK move drives decision → summary and ends the turn 'continue'", async () => {
    const { executors, calls } = createGameExecutors({
      move: "ATTACK",
      summary: { summary: "The hero strikes the goblin." },
    });
    const states: unknown[] = [];

    const output = await runAiSdkHostExample({
      input: { playerHp: 20, enemyHp: 15 },
      onStep: (value) => states.push(value),
      executors,
    });

    // HP is the machine's arithmetic (6 damage dealt, the goblin counters);
    // the narrator only contributed the prose line embedded in the log.
    expect(output).toMatchObject({ outcome: "continue", enemyHp: 9 });
    expect(output?.summary).toContain("The hero strikes the goblin.");
    // Host owned the loop: it chose a move, then narrated the turn, in order.
    expect(calls).toEqual(["decide", "summarize"]);
    // The step callback saw the machine pass through choosing → summarizing.
    expect(states).toContain("choosingMove");
    expect(states).toContain("summarizing");
  });

  test("an attack that drops the goblin to 0 wins the turn", async () => {
    const { executors } = createGameExecutors({
      move: "ATTACK",
      summary: { summary: "The goblin falls." },
    });

    // 4 HP left, 6 damage: the machine — not the narrator — decides this is a win.
    const output = await runAiSdkGameTurn({ playerHp: 18, enemyHp: 4 }, undefined, executors);

    expect(output).toMatchObject({ outcome: "won", playerHp: 18, enemyHp: 0 });
    expect(output?.summary).toContain("The goblin falls.");
  });

  test("FLEE ends the turn without a summary request", async () => {
    const { executors, calls } = createGameExecutors({ move: "FLEE" });

    const output = await runAiSdkGameTurn({ playerHp: 20, enemyHp: 15 }, undefined, executors);

    expect(output).toBeDefined();
    expect(output?.outcome).toBe("fled");
    expect(output?.summary).toContain("You disengage and back away.");
    // Fleeing skips summarizing entirely.
    expect(calls).toEqual(["decide"]);
    expect(calls).not.toContain("summarize");
  });
});
