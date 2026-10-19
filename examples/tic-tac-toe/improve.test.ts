import { describe, expect, test } from "vitest";
import type { AgentWorkflowConfig } from "@statelyai/agent";
import { createMockModelExecutors, type MockTextEntry } from "../mock-model.js";
import { evaluatePolicy, improvePolicy, objective, unknownFeaturePaths } from "./improve.js";
import { createInMemoryEventLogStore } from "@statelyai/agent/log";
import { loadPolicy } from "./policy.js";
import { CLIMB, ladder, OPTIMAL, RULES } from "./test-doubles.js";

const v0 = loadPolicy("v0");

/** The scripted reflection model, and the prompts it was sent. */
function reflection(proposals: MockTextEntry[]) {
  const executors = createMockModelExecutors({ text: { proposePolicy: proposals } });
  const prompts = () =>
    executors.calls
      .filter((call) => call.name === "proposePolicy")
      .map((call) => call.request.prompt ?? "");
  return { executors, prompts };
}

/** Reads a feature the vocabulary does not have. */
const unknownFeature: AgentWorkflowConfig = {
  ...CLIMB.v1,
  id: "unknown-feature",
  states: {
    ...CLIMB.v1.states,
    choosing: {
      type: "choice",
      choice: [
        { guard: "{{ context.facts.winningMoves.length }}", target: "win" },
        { target: "firstEmpty" },
      ],
    },
  },
};

/** Corners first, then the first empty cell: no win, no block. */
const losesMore = ladder("loses-more", [RULES.corner]);

describe("objective", () => {
  test("losing lines dominate, then wins, then size; a loss is -Infinity once never-lose holds", async () => {
    const store = createInMemoryEventLogStore();
    const [e0, e2, e3] = [
      await evaluatePolicy(v0, { store, threadPrefix: "o/v0" }),
      await evaluatePolicy(CLIMB.v2, { store, threadPrefix: "o/v2" }),
      await evaluatePolicy(CLIMB.v3, { store, threadPrefix: "o/v3" }),
    ];
    const [s0, s2, s3] = [objective(e0), objective(e2), objective(e3)];
    expect(s0).toBeCloseTo(-429 + 0.5 * (11 / 40) - 0.001 * 2, 6);
    expect(s2).toBeGreaterThan(s0);
    expect(s3).toBeGreaterThan(s2);
    expect(s3).toBeGreaterThan(0);
    // The hard constraint: once a never-losing policy is in force, losing is -Infinity.
    expect(objective(e2, { neverLoseRequired: true })).toBe(Number.NEGATIVE_INFINITY);
    expect(objective(e3, { neverLoseRequired: true })).toBe(s3);
  });

  test("the features gate allows only the vocabulary", () => {
    expect(unknownFeaturePaths(CLIMB.v3)).toEqual([]);
    expect(unknownFeaturePaths(OPTIMAL)).toEqual([]);
    expect(unknownFeaturePaths(unknownFeature)).toEqual(["context.facts.winningMoves.length"]);
    expect(unknownFeaturePaths({ x: "{{ context.facts.empty.0.cell }}" })).toHaveLength(1);
  });
});

describe("improvePolicy (the hill climb)", () => {
  test(
    "v0 -> v1 (win) -> v2 (block) -> v3 (the full ladder): each round promotes, the last is proven",
    { timeout: 60_000 },
    async () => {
      const { executors, prompts } = reflection([CLIMB.v1, CLIMB.v2, CLIMB.v3, CLIMB.v3]);
      const result = await improvePolicy({ current: v0, executors, rounds: 5 });

      const trace = result.rounds.map((round) => ({
        current: round.current.id,
        proposed: round.proposed?.id,
        losingLines: round.evaluation.losingLines.count,
        promoted: round.promoted,
      }));
      console.log(
        result.rounds
          .map(
            (r) =>
              `round ${r.round}: ${r.current.id} ${r.objective.toFixed(3)} -> ${r.proposed?.id} ${r.candidate?.objective.toFixed(3)} ${r.promoted ? "promoted" : "kept"}`,
          )
          .join("\n"),
      );
      expect(trace).toEqual([
        { current: "ttt-policy-v0", proposed: "ttt-policy-v1", losingLines: 429, promoted: true },
        { current: "ttt-policy-v1", proposed: "ttt-policy-v2", losingLines: 329, promoted: true },
        { current: "ttt-policy-v2", proposed: "ttt-policy-v3", losingLines: 67, promoted: true },
        // Round 4 proposes v3 again: not strictly better, so the climb stops.
        { current: "ttt-policy-v3", proposed: "ttt-policy-v3", losingLines: 0, promoted: false },
      ]);
      expect(result.config.id).toBe("ttt-policy-v3");
      expect(result.rounds.at(-1)!.evaluation.proof).toMatchObject({
        neverLoses: true,
        complete: true,
      });
      for (const round of result.rounds) {
        expect(round.gates.slice(0, -1).every((gate) => gate.ok)).toBe(true);
        expect(round.gates.map((gate) => gate.name)).toEqual([
          "validate",
          "vocabulary",
          "lower",
          "lint",
          "explore",
          "features",
          "moves",
          "objective",
        ]);
      }

      // The reflection prompt: goal, objective, environment, policy, vocabulary, the proof's witness, the traces.
      const [first] = prompts();
      expect(first).toContain("## Goal\nPlay O in tic-tac-toe");
      expect(first).toContain("objective = -(losing lines)");
      expect(first).toContain("## ENVIRONMENT (read-only");
      expect(first).toContain("Machine tic-tac-toe\nGoal: Play O");
      expect(first).toContain("Machine ttt-policy-v0");
      expect(first).toContain("- forcesSafeBlock: ");
      expect(first).toContain(
        "Proof: REFUTED: shortest losing game X 0, O 1, X 3, O 2, X 6 → X O O / X . . / X . .",
      );
      expect(first).toContain("Losing lines: 429");
      expect(first).toMatch(/Lost games \(from the event log\):\n- greedy\/0: X 0, O 1/);
      // The reference policy never reaches the improver.
      for (const prompt of prompts()) expect(prompt).not.toContain("ttt-policy-optimal");

      // Every game is a thread: `<round>/<opponent>/<game>`, candidates under `<round>/candidate/`.
      const entries = await result.store.read("round-1/random/0");
      expect(entries[0]?.event.type).toBe("@agent.init");
      const { threadIds } = await result.store.listThreads!({
        prefix: "round-2/candidate/perfect/",
      });
      expect(threadIds).toHaveLength(5);
    },
  );

  test("a proposal with an unknown feature is refused by the features gate and repaired", async () => {
    const { executors, prompts } = reflection([unknownFeature, CLIMB.v1]);
    const result = await improvePolicy({ current: v0, executors });
    const [round] = result.rounds;
    expect(round!.repairs).toBe(1);
    expect(round!.promoted).toBe(true);
    expect(prompts()[1]).toContain(
      "gate 'features' failed: unknown template paths: context.facts.winningMoves.length",
    );
  });

  test("an unknown feature that is never repaired is not promoted", async () => {
    const { executors } = reflection([unknownFeature]);
    const result = await improvePolicy({ current: v0, executors, maxRepairs: 0 });
    expect(result.rounds[0]!.promoted).toBe(false);
    expect(result.rounds[0]!.gates.at(-1)).toMatchObject({ name: "features", ok: false });
    expect(result.config).toBe(v0);
  });

  test("a proposal that loses more lines is refused by the objective", async () => {
    const { executors } = reflection([losesMore]);
    const result = await improvePolicy({ current: CLIMB.v2, executors });
    const [round] = result.rounds;
    expect(round!.candidate!.evaluation.losingLines.count).toBeGreaterThan(
      round!.evaluation.losingLines.count,
    );
    expect(round!.gates.at(-1)).toMatchObject({ name: "objective", ok: false });
    expect(round!.promoted).toBe(false);
    expect(result.config).toBe(CLIMB.v2);
  });

  test("once never-lose holds, any losing proposal is -Infinity", async () => {
    const { executors } = reflection([CLIMB.v2]);
    const result = await improvePolicy({ current: CLIMB.v3, executors });
    expect(result.rounds[0]!.candidate!.objective).toBe(Number.NEGATIVE_INFINITY);
    expect(result.rounds[0]!.promoted).toBe(false);
  });
});
