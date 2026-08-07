import { describe, expect, test } from "vitest";
import type { InspectionEvent } from "xstate";
import type { AgentDecisionExecutor, AgentRequestExecutor, ChosenEvent } from "@statelyai/agent";
import type { SnapshotFrom } from "xstate";
import {
  gameMachine,
  resolveInteractionLabel,
  runGameLoopExample,
  type HumanEvent,
} from "./index.js";
import { getStateMeta } from "@statelyai/agent";

type GameSnapshot = SnapshotFrom<typeof gameMachine>;

/**
 * Scripted opponent: roll with nothing at stake, bank as soon as there is
 * something to bank. Records every prompt so the test can inspect what the
 * long-lived agent had observed at each decision.
 */
function createMockPlayer() {
  const prompts: string[] = [];
  const decide: AgentDecisionExecutor = async (request): Promise<{ event: ChosenEvent }> => {
    const prompt = request.prompt ?? "";
    prompts.push(prompt);
    return { event: prompt.includes("Turn total: 0") ? { type: "ROLL" } : { type: "BANK" } };
  };
  return { decide, prompts };
}

function createMockReferee(replies: boolean[]) {
  const prompts: string[] = [];
  const generateText: AgentRequestExecutor = async (request) => {
    prompts.push(request.prompt ?? "");
    const playAgain = replies[prompts.length - 1] ?? false;
    return { output: { playAgain, reasoning: "scripted" } };
  };
  return { generateText, prompts };
}

/**
 * Human driven purely by accepted machine events: bank as soon as something is
 * accrued, otherwise roll; answer the round question with the next reply.
 */
function createMockHuman(roundReplies: string[]) {
  const roundPrompts: string[] = [];
  const nextHumanEvent = (snapshot: GameSnapshot): HumanEvent => {
    if (snapshot.can({ type: "ROUND_REPLY", reply: "" })) {
      roundPrompts.push(snapshot.context.notice);
      return {
        type: "ROUND_REPLY",
        reply: roundReplies[roundPrompts.length - 1] ?? "no thanks",
      };
    }
    return snapshot.can({ type: "HUMAN_BANK" }) ? { type: "HUMAN_BANK" } : { type: "HUMAN_ROLL" };
  };
  return { nextHumanEvent, roundPrompts };
}

describe("game-loop-agent", () => {
  test("the invoked agent watches every substate and moves only on its turn", async () => {
    const player = createMockPlayer();
    const referee = createMockReferee([true, false]);
    const human = createMockHuman(["sure, one more", "nah, I'm done"]);

    const output = await runGameLoopExample({
      input: { seed: 5, target: 10, maxRounds: 5 },
      decide: player.decide,
      generateText: referee.generateText,
      nextHumanEvent: human.nextHumanEvent,
    });

    expect(output).toMatchObject({ reason: "user-stopped", rounds: 2 });
    expect(output.humanWins).toBe(1);
    expect(output.agentWins).toBe(1);

    // The agent moved many times across two rounds.
    expect(player.prompts.length).toBeGreaterThan(3);

    // Within a run segment, observations arrive as they happen, including the
    // opponent's moves the game machine pushed while the agent was watching.
    expect(player.prompts[1]).toContain("agent rolled");
    expect(player.prompts[0]).toContain("human banked");

    // The long-lived proof: every human move settles the run idle, and the
    // resume from `persistedSnapshot` restores the `player` child WITH its
    // accumulated observations — so no post-resume decision ever starts from
    // an empty history, and round-1 events are still visible in round 2.
    expect(player.prompts.some((prompt) => prompt.includes("(nothing yet)"))).toBe(false);
    const lastPrompt = player.prompts.at(-1)!;
    expect(lastPrompt).toContain("Round 1 won by");
  });

  test("the round question's label resolves {notice} to who won", async () => {
    const player = createMockPlayer();
    const referee = createMockReferee([false]);
    const labels: string[] = [];
    const human = createMockHuman(["done"]);
    const nextHumanEvent = (snapshot: GameSnapshot): HumanEvent => {
      if (snapshot.can({ type: "ROUND_REPLY", reply: "" })) {
        const label = getStateMeta(snapshot).interaction?.label ?? "";
        labels.push(resolveInteractionLabel(label, snapshot.context));
      }
      return human.nextHumanEvent(snapshot);
    };

    await runGameLoopExample({
      input: { seed: 5, target: 10, maxRounds: 5 },
      decide: player.decide,
      generateText: referee.generateText,
      nextHumanEvent,
    });

    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatch(/^(human|agent) won the round\. Another round, or call it here\?$/);
  });

  test("round control is decided from the free-text reply", async () => {
    const player = createMockPlayer();
    const referee = createMockReferee([false]);
    const human = createMockHuman(["that's enough for today"]);

    const output = await runGameLoopExample({
      input: { seed: 5, target: 10, maxRounds: 5 },
      decide: player.decide,
      generateText: referee.generateText,
      nextHumanEvent: human.nextHumanEvent,
    });

    expect(referee.prompts).toHaveLength(1);
    expect(referee.prompts[0]).toContain("that's enough for today");
    expect(output).toMatchObject({ rounds: 1, reason: "user-stopped" });
  });

  test("one inspector sees both actors: the game machine and the player agent", async () => {
    const player = createMockPlayer();
    const referee = createMockReferee([false]);
    const human = createMockHuman(["done"]);

    const events: InspectionEvent[] = [];
    await runGameLoopExample({
      input: { seed: 5, target: 10, maxRounds: 5 },
      decide: player.decide,
      generateText: referee.generateText,
      nextHumanEvent: human.nextHumanEvent,
      inspect: (inspectionEvent) => events.push(inspectionEvent),
    });

    // Both actors register in the same inspection stream: the root game
    // machine (no parent) and the invoked player agent.
    const actorEvents = events.filter((e) => e.type === "@xstate.actor");
    const spawnedIds = actorEvents.map((e) => e.id);
    expect(spawnedIds).toContain("player");
    expect(actorEvents.some((e) => e.parentRef === undefined)).toBe(true);

    // Both actors transition, so an inspector renders each one's live
    // statechart — not just the root's.
    const refToId = new Map(actorEvents.map((e) => [e.actorRef, e.id]));
    const transitionedIds = new Set(
      events.filter((e) => e.type === "@xstate.transition").map((e) => refToId.get(e.actorRef)),
    );
    expect(transitionedIds).toContain("player");
    expect(transitionedIds.size).toBeGreaterThanOrEqual(2);

    // Game events flow between the two as inspectable communication.
    const inspectedEventTypes = new Set(
      events.filter((e) => e.type === "@xstate.transition").map((e) => e.eventType),
    );
    expect(inspectedEventTypes).toContain("OBSERVE");
    expect(inspectedEventTypes).toContain("YOUR_TURN");
    expect(inspectedEventTypes).toContain("AGENT_MOVE");
  });

  test("the round limit ends the match even when the user keeps saying yes", async () => {
    const player = createMockPlayer();
    const referee = createMockReferee([true, true, true, true]);
    const human = createMockHuman(["again", "again", "again", "again"]);

    const output = await runGameLoopExample({
      input: { seed: 5, target: 10, maxRounds: 2 },
      decide: player.decide,
      generateText: referee.generateText,
      nextHumanEvent: human.nextHumanEvent,
    });

    expect(output).toMatchObject({ reason: "round-limit", rounds: 2 });
  });
});
