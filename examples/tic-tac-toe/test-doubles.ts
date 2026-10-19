/**
 * Test doubles for this example. Tests only; nothing here is exported from
 * index.ts.
 *
 *   - `ladder`: builds a policy config from an ordered rule list (one choice
 *     branch and one final state per rule), the shape a reflection model
 *     proposes. The climb's scripted proposals are ladders.
 *   - `CLIMB`: the scripted proposals v1 (add win), v2 (add block), v3 (the
 *     full ladder: fork, forcing block, block fork, center, opposite corner,
 *     corner, edge).
 *   - `OPTIMAL`: the hand-written reference, test-fixtures/optimal.json.
 *   - `optimalChoice`: a mock-model / mock-judge answer that plays the
 *     reference policy's move.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentWorkflowConfig, ChosenEvent } from "@statelyai/agent";
import type { MockDecisionEntry } from "../mock-model.js";
import type { FeatureName } from "./features.js";
import type { Board } from "./game.js";
import { boardOf, lowerPolicy, policyMove } from "./policy.js";

export type Rule = { name: string; feature: Exclude<FeatureName, "board">; description: string };

export const RULES = {
  win: { name: "win", feature: "completesMyLine", description: "Complete my line." },
  block: { name: "block", feature: "completesTheirLine", description: "Block their line." },
  fork: { name: "fork", feature: "createsMyFork", description: "Make two threats at once." },
  force: {
    name: "force",
    feature: "forcesSafeBlock",
    description: "Make a threat whose block gives them no fork.",
  },
  blockFork: {
    name: "blockFork",
    feature: "createsTheirFork",
    description: "Take their fork cell.",
  },
  center: { name: "center", feature: "center", description: "Take the center." },
  oppositeCorner: {
    name: "oppositeCorner",
    feature: "oppositeCornerOfTheirs",
    description: "Take the corner opposite theirs.",
  },
  corner: { name: "corner", feature: "corners", description: "Take an empty corner." },
  edge: { name: "edge", feature: "edges", description: "Take an empty edge." },
} satisfies Record<string, Rule>;

/** A policy that tries `rules` in order, then plays the first empty cell. */
export function ladder(id: string, rules: Rule[]): AgentWorkflowConfig {
  const finals = Object.fromEntries(
    rules.map((rule) => [
      rule.name,
      {
        type: "final" as const,
        description: rule.description,
        output: { type: "O.play", cell: `{{ context.facts.${rule.feature}.0 }}` },
      },
    ]),
  );
  return {
    id,
    description: `Rules in order: ${[...rules.map((rule) => rule.name), "firstEmpty"].join(", ")}.`,
    context: { facts: "{{ input }}" },
    initial: "choosing",
    states: {
      choosing: {
        type: "choice",
        choice: [
          ...rules.map((rule) => ({
            guard: `{{ context.facts.${rule.feature}.length }}`,
            target: rule.name,
          })),
          { target: "firstEmpty" },
        ],
      },
      ...finals,
      firstEmpty: {
        type: "final",
        description: "The lowest empty cell.",
        output: { type: "O.play", cell: "{{ context.facts.empty.0 }}" },
      },
    },
  };
}

const { win, block, fork, force, blockFork, center, oppositeCorner, corner, edge } = RULES;

/** The scripted climb: each proposal adds rules to the last. */
export const CLIMB = {
  v1: ladder("ttt-policy-v1", [win]),
  v2: ladder("ttt-policy-v2", [win, block]),
  v3: ladder("ttt-policy-v3", [
    win,
    block,
    fork,
    force,
    blockFork,
    center,
    oppositeCorner,
    corner,
    edge,
  ]),
};

export const OPTIMAL = JSON.parse(
  readFileSync(fileURLToPath(new URL("./test-fixtures/optimal.json", import.meta.url)), "utf-8"),
) as AgentWorkflowConfig;

const optimalMachine = lowerPolicy(OPTIMAL);

/** The reference policy's move on `board`. */
export const optimalCell = (board: Board) => policyMove(optimalMachine, board).cell;

/** A mock-model decision entry that plays the reference move. */
export const optimalChoice: MockDecisionEntry = (request) =>
  ({ type: "O.play", cell: optimalCell(boardOf(request)) }) satisfies ChosenEvent;
