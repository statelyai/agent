import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { type AgentRequestExecutors, type AgentTextRequest } from "@statelyai/agent";
import { lintAgentMachine } from "@statelyai/agent/testing";
import { createMockModelExecutors } from "../mock-model.js";
import {
  BEAM_SIZE,
  MAX_DEPTH,
  MAX_PROPOSALS,
  applyStep,
  canReach24,
  formatValue,
  runTreeOfThoughtsExample,
  treeOfThoughtsMachine,
} from "./index.js";

/**
 * Only the `propose` request is mocked. Proposers answer from the request's
 * own input (the line's remaining numbers), so an answer cannot land on the
 * wrong beam entry. Everything else — refereeing, scoring, pruning — is the
 * machine's real code.
 */
const remainingOf = (request: AgentTextRequest) =>
  (request.input as { remaining: number[] }).remaining;
const key = (values: number[]) => [...values].sort((a, b) => a - b).join(",");

/** A table proposer: sorted remaining numbers → the steps to propose. */
function tableProposer(table: Record<string, string[]>) {
  return createMockModelExecutors({
    text: {
      propose: [
        (request: AgentTextRequest) => ({
          candidates: (table[key(remainingOf(request))] ?? ["1 + 1 = 2"]).map((operation) => ({
            operation,
          })),
        }),
      ],
    },
  });
}

/** A competent proposer: legal steps only, lines that can still reach 24 first. */
function competentProposer() {
  return createMockModelExecutors({
    text: {
      propose: [
        (request: AgentTextRequest) => {
          const values = remainingOf(request);
          const steps: Array<{ operation: string; live: boolean }> = [];
          values.forEach((a, i) =>
            values.forEach((b, j) => {
              if (i === j) return;
              const rest = values.filter((_, index) => index !== i && index !== j);
              const options: Array<[string, number]> = [
                ["+", a + b],
                ["-", a - b],
                ["*", a * b],
                ...(b !== 0 ? [["/", a / b] as [string, number]] : []),
              ];
              for (const [op, result] of options) {
                steps.push({
                  operation: `${formatValue(a)} ${op} ${formatValue(b)} = ${formatValue(result)}`,
                  live: canReach24([...rest, result]),
                });
              }
            }),
          );
          const ordered = [...steps.filter((s) => s.live), ...steps.filter((s) => !s.live)];
          return {
            candidates: ordered.slice(0, MAX_PROPOSALS).map(({ operation }) => ({ operation })),
          };
        },
      ],
    },
  });
}

// The tutorial's puzzle, solved as (10 - 4) * (13 - 9).
const solvingTable: Record<string, string[]> = {
  "4,9,10,13": ["10 - 4 = 6", "13 - 9 = 4", "4 + 9 = 13"],
  "6,9,13": ["13 - 9 = 4"],
  "4,4,10": ["10 - 4 = 6"],
  "10,13,13": ["13 / 13 = 1"],
  "4,6": ["6 * 4 = 24"],
  "1,10": ["10 + 1 = 11"],
};

test("a valid line is found, re-derived, and reported as a full equation", async () => {
  const scripted = tableProposer(solvingTable);
  const result = await runTreeOfThoughtsExample({
    numbers: [4, 9, 10, 13],
    generateText: scripted.generateText,
  });

  expect(result.progress.at(-1)).toBe("done");
  expect(result.solution).toBe("(10 - 4) * (13 - 9) = 24");
  expect(result.notice).toBe("Solved 4, 9, 10, 13: (10 - 4) * (13 - 9) = 24");
  expect(result.depth).toBe(MAX_DEPTH);
  expect(result.rejectedSteps).toEqual([]);
  // Depth 1: one call (the root). Depths 2 and 3: one call per beam entry.
  expect(scripted.calls.filter((call) => call.name === "propose")).toHaveLength(1 + BEAM_SIZE * 2);
  expect(result.candidatesConsidered).toBe(3 + 3 + 3);
  expect(result.progress.filter((state) => state === "scoring")).toHaveLength(MAX_DEPTH);
});

test("an illegal step is rejected while its legal sibling survives", async () => {
  const scripted = tableProposer({
    ...solvingTable,
    "4,9,10,13": [
      "7 + 13 = 20", // 7 is not on the table
      "9 * 9 = 81", // only one 9
      "10 - 4 = 5", // wrong arithmetic
      "make 24 somehow", // not a step
      "10 - 4 = 6", // legal
    ],
  });
  const result = await runTreeOfThoughtsExample({
    numbers: [4, 9, 10, 13],
    generateText: scripted.generateText,
  });

  expect(result.rejectedSteps).toEqual([
    'depth 1: "7 + 13 = 20" — 7 is not in the remaining numbers [4, 9, 10, 13]',
    'depth 1: "9 * 9 = 81" — 9 is not in the remaining numbers [4, 9, 10, 13] (after using 9)',
    'depth 1: "10 - 4 = 5" — wrong arithmetic: 10 - 4 = 6',
    "depth 1: \"make 24 somehow\" — not of the form 'a op b = c'",
  ]);
  // Only the legal sibling reached depth 2: exactly one expansion there.
  const depth2 = scripted.calls
    .filter((call) => call.name === "propose")
    .map((call) => key((call.input as { remaining: number[] }).remaining));
  expect(depth2[1]).toBe("6,9,13");
  expect(depth2).not.toContain("5,9,13");
  expect(depth2).not.toContain("13,20,4");
  expect(result.progress.at(-1)).toBe("done");
  expect(result.solution).toBe("(10 - 4) * (13 - 9) = 24");
});

test("every step illegal → beam empty → failed at depth 1", async () => {
  const result = await runTreeOfThoughtsExample({
    numbers: [4, 9, 10, 13],
    generateText: tableProposer({ "4,9,10,13": ["24 = 24", "100 - 76 = 24"] }).generateText,
  });
  expect(result.progress.at(-1)).toBe("failed");
  expect(result.depth).toBe(1);
  expect(result.solution).toBeNull();
  expect(result.notice).toBe(
    "No solution for 4, 9, 10, 13: every proposed step at depth 1 was illegal.",
  );
  expect(result.rejectedSteps).toHaveLength(2);
});

test("depth budget spent → failed with the best line", async () => {
  // Legal but hopeless steps: the line runs out of numbers without making 24.
  const result = await runTreeOfThoughtsExample({
    numbers: [4, 9, 10, 13],
    generateText: tableProposer({
      "4,9,10,13": ["4 + 9 = 13"],
      "10,13,13": ["13 + 13 = 26"],
      "10,26": ["26 + 10 = 36"],
    }).generateText,
  });
  expect(result.progress.at(-1)).toBe("failed");
  expect(result.depth).toBe(MAX_DEPTH);
  expect(result.notice).toBe(
    `No solution for 4, 9, 10, 13: no line reached 24 within ${MAX_DEPTH} steps. ` +
      "Best line: 4 + 9 = 13; 13 + 13 = 26; 26 + 10 = 36.",
  );
});

test("a proposer error lands in failed", async () => {
  const down: AgentRequestExecutors["generateText"] = async () => {
    throw new Error("model offline");
  };
  const result = await runTreeOfThoughtsExample({ generateText: down });
  expect(result.progress.at(-1)).toBe("failed");
  expect(result.notice).toContain("propose failed");
});

test("the referee: applyStep and canReach24", () => {
  const root = { expression: "", remaining: [4, 9, 10, 13], terms: ["4", "9", "10", "13"] };
  expect(applyStep(root, "13 / 4 = 3.25")).toEqual({
    entry: {
      expression: "13 / 4 = 3.25",
      remaining: [9, 10, 3.25],
      terms: ["9", "10", "(13 / 4)"],
    },
  });
  expect(applyStep(root, "10 × 4 = 40")).toMatchObject({ entry: { remaining: [9, 13, 40] } });
  expect(applyStep(root, "9 / 0 = 0")).toEqual({
    reason: "0 is not in the remaining numbers [4, 9, 10, 13] (after using 9)",
  });
  expect(canReach24([6, 4])).toBe(true);
  expect(canReach24([1, 1, 1, 1])).toBe(false);
  expect(canReach24([3, 3, 8, 8])).toBe(true); // 8 / (3 - 8 / 3)
});

test("starters behave as their labels advertise", async () => {
  const starters = JSON.parse(readFileSync(new URL("./metadata.json", import.meta.url), "utf8"))
    .starters as Array<{ label: string; input: { numbers: number[] } }>;
  expect(starters.length).toBeGreaterThanOrEqual(2);
  for (const starter of starters) {
    const result = await runTreeOfThoughtsExample({
      numbers: starter.input.numbers,
      generateText: competentProposer().generateText,
    });
    if (starter.label.startsWith("Solvable")) {
      expect(result.progress.at(-1)).toBe("done");
      expect(result.solution).toMatch(/= 24$/);
    } else {
      expect(starter.label).toContain("ends in failed");
      expect(result.progress.at(-1)).toBe("failed");
      expect(result.depth).toBe(MAX_DEPTH);
    }
    expect(result.rejectedSteps).toEqual([]);
  }
});

test("machine lints clean", () => {
  lintAgentMachine(treeOfThoughtsMachine, { throw: true, warnings: true });
});
