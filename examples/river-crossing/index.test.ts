import { describe, expect, test } from "vitest";
import { runAgent } from "../../src/index.js";
import type { AgentDecisionRequest, ChosenEvent } from "../../src/index.js";
import { describeMachine, riverCrossingMachine, riverCrossingSchemas } from "./index.js";

// A decide executor that plays a fixed script of event types in order.
function scriptedDecide(script: string[]) {
  let i = 0;
  return async (_request: AgentDecisionRequest): Promise<{ event: ChosenEvent }> => {
    const type = script[i++] ?? "CROSS_ALONE";
    return { event: { type, reasoning: `scripted ${type}` } };
  };
}

const OPTIMAL: string[] = [
  "TAKE_GOAT", // farmer+goat L→R
  "CROSS_ALONE", // farmer R→L
  "TAKE_WOLF", // farmer+wolf L→R
  "TAKE_GOAT", // farmer+goat R→L
  "TAKE_CABBAGE", // farmer+cabbage L→R
  "CROSS_ALONE", // farmer R→L
  "TAKE_GOAT", // farmer+goat L→R → solved
];

describe("river-crossing", () => {
  test("scripted optimal 7-move solution reaches solved with correct output", async () => {
    const result = await runAgent(riverCrossingMachine, {
      input: { maxMoves: 12 },
      executors: { generateText: async () => ({ output: "" }), decide: scriptedDecide(OPTIMAL) },
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    expect(result.output.solved).toBe(true);
    expect(result.output.moves).toBe(7);
    expect(result.output.log).toHaveLength(7);
    expect(result.output.log[0]).toBe("Farmer crosses left → right with the goat");
    expect(result.output.log.at(-1)).toBe("Farmer crosses left → right with the goat");
  });

  test("illegal move is rejected-by-guard, then the legal retry proceeds", async () => {
    // From the start (all on the left), CROSS_ALONE leaves wolf+goat (and
    // goat+cabbage) together without the farmer — illegal. The machine rejects
    // it; the retry picks the only safe opener, TAKE_GOAT.
    let firstCall = true;
    const requestsSeen: AgentDecisionRequest[] = [];
    const decide = async (request: AgentDecisionRequest): Promise<{ event: ChosenEvent }> => {
      requestsSeen.push(request);
      if (firstCall) {
        firstCall = false;
        return { event: { type: "CROSS_ALONE", reasoning: "illegal opener" } };
      }
      // After the rejected opener, play the rest of the optimal solution.
      const type = OPTIMAL[requestsSeen.length - 2] ?? "CROSS_ALONE";
      return { event: { type, reasoning: `scripted ${type}` } };
    };

    const result = await runAgent(riverCrossingMachine, {
      input: { maxMoves: 12 },
      executors: { generateText: async () => ({ output: "" }), decide },
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    // The first decide attempt failed the guard, retried within the same
    // deciding state, and TAKE_GOAT applied.
    expect(requestsSeen[1]!.attempts.at(-1)!.failure).toBe("rejected-by-guard");
    expect(result.output.solved).toBe(true);
    expect(result.output.log[0]).toBe("Farmer crosses left → right with the goat");
  });

  test("exceeding maxMoves reaches failed", async () => {
    // Ferry the goat back and forth: each crossing is legal but makes no
    // progress, so the move budget runs out before solving.
    const shuttle = ["TAKE_GOAT", "TAKE_GOAT", "TAKE_GOAT", "TAKE_GOAT"];
    const result = await runAgent(riverCrossingMachine, {
      input: { maxMoves: 3 },
      executors: { generateText: async () => ({ output: "" }), decide: scriptedDecide(shuttle) },
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    expect(result.output.solved).toBe(false);
    expect(result.output.moves).toBe(3);
  });

  test("describeMachine renders states, events, and rules into markdown", () => {
    const md = describeMachine(riverCrossingMachine, riverCrossingSchemas, {
      title: "River Crossing",
      rules: ["A move is illegal if it leaves an unsafe pair."],
    });

    expect(md).toContain("# River Crossing");
    expect(md).toContain("## Rules");
    expect(md).toContain("A move is illegal if it leaves an unsafe pair.");
    // Every event schema key is listed.
    for (const name of Object.keys(riverCrossingSchemas.events)) {
      expect(md).toContain(`**${name}**`);
    }
    // Every state name is listed, including the invoke source.
    expect(md).toContain("**deciding**");
    expect(md).toContain("agent.decide");
    expect(md).toContain("**solved**");
    expect(md).toContain("**failed**");
  });
});
