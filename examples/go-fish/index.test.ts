import { describe, expect, test } from "vitest";
import type { AgentDecisionRequest, ChosenEvent } from "@statelyai/agent";
import { runAgent } from "@statelyai/agent";
import { goFishMachine, idleLabel, runGoFishExample, type Rank } from "./index.js";

const deck: Rank[] = [
  "A",
  "A",
  "2",
  "3",
  "4",
  "5",
  "6",
  "2",
  "2",
  "3",
  "4",
  "5",
  "6",
  "6",
  "3",
  "A",
  "A",
  "2",
  "3",
  "4",
  "4",
  "5",
  "5",
  "6",
];

describe("go-fish", () => {
  test("alternates to the human after every agent ask", async () => {
    const matchingDeck: Rank[] = [
      "A",
      "A",
      "2",
      "3",
      "4",
      "5",
      "6",
      "A",
      "2",
      "2",
      "3",
      "4",
      "5",
      "6",
      "3",
      "A",
      "2",
      "3",
      "4",
      "4",
      "5",
      "5",
      "6",
      "6",
    ];
    let agentCalls = 0;
    const labels: string[] = [];

    const output = await runGoFishExample({
      input: { deck: matchingDeck, maxTurns: 2, seed: 0 },
      decide: async (): Promise<{ event: ChosenEvent }> => {
        agentCalls += 1;
        return { event: { type: "AGENT_ASK", rank: "A" } };
      },
      nextAsk: (snapshot) => {
        labels.push(idleLabel(snapshot));
        return "2";
      },
    });

    expect(output.turns).toBe(2);
    expect(agentCalls).toBe(1);
    expect(labels).toHaveLength(1);
    expect(labels[0]).toContain("Your hand:");
  });

  test("keeps hands hidden while the machine enforces both players' turns", async () => {
    const decisionPrompts: string[] = [];
    const labels: string[] = [];

    const output = await runGoFishExample({
      input: { deck, maxTurns: 2, seed: 0 },
      decide: async (request: AgentDecisionRequest): Promise<{ event: ChosenEvent }> => {
        decisionPrompts.push(request.prompt ?? "");
        return { event: { type: "AGENT_ASK", rank: "A" } };
      },
      nextAsk: (snapshot) => {
        labels.push(idleLabel(snapshot));
        return "2";
      },
    });

    expect(output).toMatchObject({ turns: 2, reason: "turn-limit" });
    expect(decisionPrompts[0]).toContain("Your hand: A A 2 3 4 5 6");
    expect(decisionPrompts[0]).not.toContain("Human hand:");
    expect(labels[0]).toContain("Your hand: 2 2 3 4 5 6 6");
    expect(labels[0]).not.toContain("Agent hand:");
  });

  test("rejects an ask for a rank absent from the agent hand", async () => {
    let calls = 0;
    const requests: AgentDecisionRequest[] = [];
    const noAceAgentDeck: Rank[] = ["2", "2", "3", "3", "4", "5", "6", ...deck.slice(7)];

    const result = await runAgent(goFishMachine, {
      input: { deck: noAceAgentDeck, maxTurns: 1, seed: 0 },
      executors: {
        decide: async (request): Promise<{ event: ChosenEvent }> => {
          requests.push(request);
          calls += 1;
          return { event: { type: "AGENT_ASK", rank: calls === 1 ? "A" : "2" } };
        },
      },
    });

    expect(result.status).toBe("done");
    expect(calls).toBe(2);
    expect(requests[1]!.attempts[0]!.failure).toBe("rejected-by-guard");
  });

  test("stays idle on an illegal human ask and advances on a legal one", async () => {
    let first = await runAgent(goFishMachine, {
      input: { deck, maxTurns: 4, seed: 0 },
      executors: {
        decide: async (): Promise<{ event: ChosenEvent }> => ({
          event: { type: "AGENT_ASK", rank: "A" },
        }),
      },
    });

    expect(first.status).toBe("idle");
    if (first.status !== "idle") throw new Error("expected idle");
    // "A" is not in the human hand (2 2 3 4 5 6 6): the transition returns
    // undefined, so nothing happens and the run settles idle again.
    const rejected = await runAgent(goFishMachine, {
      snapshot: first.persistedSnapshot,
      event: { type: "ASK", rank: "A" },
      executors: {
        decide: async (): Promise<{ event: ChosenEvent }> => ({
          event: { type: "AGENT_ASK", rank: "A" },
        }),
      },
    });

    expect(rejected.status).toBe("idle");
    if (rejected.status !== "idle") throw new Error("expected idle");
    expect(rejected.snapshot.context.turns).toBe(first.snapshot.context.turns);

    const accepted = await runAgent(goFishMachine, {
      snapshot: rejected.persistedSnapshot,
      event: { type: "ASK", rank: "3" },
      executors: {
        decide: async (): Promise<{ event: ChosenEvent }> => ({
          event: { type: "AGENT_ASK", rank: "A" },
        }),
      },
    });

    expect(accepted.snapshot.context.turns).toBeGreaterThan(first.snapshot.context.turns);
  });
});
