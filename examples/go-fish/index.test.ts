import { describe, expect, test } from "vitest";
import type { AgentDecisionRequest, ChosenEvent } from "@statelyai/agent";
import { runAgent } from "@statelyai/agent";
import { goFishMachine, type Rank } from "./index.js";

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
    const humanPrompts: string[] = [];

    const result = await runAgent(goFishMachine, {
      input: { deck: matchingDeck, maxTurns: 2, seed: 0 },
      executors: {
        decide: async (): Promise<{ event: ChosenEvent }> => {
          agentCalls += 1;
          return { event: { type: "AGENT_ASK", rank: "A" } };
        },
      },
      userInput: async ({ prompt }) => {
        humanPrompts.push(prompt ?? "");
        return "2";
      },
    });

    expect(result.status).toBe("done");
    expect(agentCalls).toBe(1);
    expect(humanPrompts).toHaveLength(1);
    expect(humanPrompts[0]).toContain("Your hand:");
  });

  test("keeps hands hidden while the machine enforces both players' turns", async () => {
    const decisionPrompts: string[] = [];
    const humanPrompts: string[] = [];

    const result = await runAgent(goFishMachine, {
      input: { deck, maxTurns: 2, seed: 0 },
      executors: {
        decide: async (request: AgentDecisionRequest): Promise<{ event: ChosenEvent }> => {
          decisionPrompts.push(request.prompt ?? "");
          return { event: { type: "AGENT_ASK", rank: "A" } };
        },
      },
      userInput: async ({ prompt }) => {
        humanPrompts.push(prompt ?? "");
        return "2";
      },
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    expect(result.output).toMatchObject({ turns: 2, reason: "turn-limit" });
    expect(decisionPrompts[0]).toContain("Your hand: A A 2 3 4 5 6");
    expect(decisionPrompts[0]).not.toContain("Human hand:");
    expect(humanPrompts[0]).toContain("Your hand: 2 2 3 4 5 6 6");
    expect(humanPrompts[0]).not.toContain("Agent hand:");
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
});
