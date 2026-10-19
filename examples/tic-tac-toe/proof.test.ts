import { describe, expect, test } from "vitest";
import type { AgentWorkflowConfig } from "@statelyai/agent";
import { loadPolicy, lowerPolicy, policyMove } from "./policy.js";
import { countLosingLines, provePolicy } from "./proof.js";
import { CLIMB, OPTIMAL } from "./test-doubles.js";

const v0 = lowerPolicy(loadPolicy("v0"));
const optimal = lowerPolicy(OPTIMAL);

/** Always the center, occupied or not. */
const alwaysCenter: AgentWorkflowConfig = {
  id: "always-center",
  context: { facts: "{{ input }}" },
  initial: "center",
  states: { center: { type: "final", output: { type: "O.play", cell: 4 } } },
};

describe("the proof: canReach(game, 'xWins') with the policy playing O", () => {
  test("refutes v0 with the shortest losing game", async () => {
    const proof = await provePolicy(v0);
    console.log(
      `v0: reachable=${proof.reachable} (${Math.round(proof.ms)}ms) ${proof.witnessText}`,
    );
    expect(proof).toMatchObject({
      neverLoses: false,
      reachable: true,
      complete: true,
      illegal: [],
    });
    // X takes a corner, O the first empty cell; X builds the left column.
    expect(proof.witnessText).toBe("X 0, O 1, X 3, O 2, X 6 → X O O / X . . / X . .");
    expect(proof.witness).toHaveLength(5);
  });

  test("proves the reference policy never loses, with a complete search", async () => {
    const proof = await provePolicy(optimal);
    console.log(
      `optimal: reachable=${proof.reachable} complete=${proof.complete} (${Math.round(proof.ms)}ms)`,
    );
    expect(proof).toMatchObject({
      neverLoses: true,
      reachable: false,
      complete: true,
      illegal: [],
    });
    expect(proof.witness).toBeUndefined();
  });

  test("the full game tree agrees: no X sequence beats the reference", async () => {
    // Without dedupeBy: every X move sequence, played out to a final state.
    expect(await countLosingLines(optimal)).toMatchObject({
      count: 0,
      complete: true,
      illegal: [],
    });
    // The opposite-corner trap: X holds two opposite corners, O the center. A
    // corner here loses to a fork; the forcing rule plays an edge.
    expect(policyMove(optimal, ["X", null, null, null, "O", null, null, null, "X"]).cell).toBe(1);
  });

  test("losing lines fall with each rule the climb adds", async () => {
    const counts = [];
    for (const config of [loadPolicy("v0"), CLIMB.v1, CLIMB.v2, CLIMB.v3]) {
      counts.push((await countLosingLines(lowerPolicy(config))).count);
    }
    expect(counts).toEqual([429, 329, 67, 0]);
  });

  test("a policy that plays an occupied cell is refuted, not vacuously proven", async () => {
    // Its O branch would be pruned by the guard and the path would never reach xWins;
    // the proof records the illegal move instead.
    const proof = await provePolicy(lowerPolicy(alwaysCenter));
    expect(proof.neverLoses).toBe(false);
    expect(proof.illegal[0]?.problem).toBe("plays occupied cell 4");
  });
});
