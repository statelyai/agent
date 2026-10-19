/**
 * Scores one policy file without any model: the gates, the proof, the losing
 * lines, the seeded match, and the objective. This is the measurement step an
 * outside improver (a person, or Claude Code with the improve-machine skill)
 * runs on each candidate.
 *
 * Run: pnpm exec tsx examples/tic-tac-toe/evaluate.ts examples/tic-tac-toe/policies/v0.json [current.json]
 *
 * With a second file, the objective applies the never-lose constraint when
 * that current policy is proven, and the last line says whether the
 * candidate would be promoted over it.
 */
import { readFileSync } from "node:fs";
import type { AgentWorkflowConfig } from "@statelyai/agent";
import { createInMemoryEventLogStore } from "@statelyai/agent/log";
import { evaluatePolicy, objective, policyGates } from "./improve.js";
import { formatGame } from "./proof.js";

const read = (path: string) => JSON.parse(readFileSync(path, "utf-8")) as AgentWorkflowConfig;

async function main(candidatePath: string, currentPath?: string) {
  const candidate = read(candidatePath);
  const gates = await policyGates(candidate);
  for (const gate of gates) {
    console.log(
      `${gate.ok ? "pass" : "FAIL"} ${gate.name}${gate.detail ? `: ${gate.detail}` : ""}`,
    );
  }
  if (gates.some((gate) => !gate.ok)) return;

  const store = createInMemoryEventLogStore();
  const current = currentPath
    ? await evaluatePolicy(read(currentPath), { store, threadPrefix: "current" })
    : undefined;
  const neverLoseRequired = current?.proof.neverLoses ?? false;
  const evaluation = await evaluatePolicy(candidate, { store, threadPrefix: "candidate" });
  const { proof, losingLines, match } = evaluation;
  console.log(
    proof.neverLoses
      ? `proof: PROVEN never to lose (${Math.round(proof.ms)}ms)`
      : `proof: REFUTED, shortest losing game ${proof.witnessText ?? "(illegal move)"}`,
  );
  console.log(`losing lines: ${losingLines.count}`);
  for (const line of losingLines.examples) console.log(`  ${formatGame(line)}`);
  for (const [opponent, t] of Object.entries(match.byOpponent)) {
    console.log(`${opponent}: ${t.wins} W / ${t.draws} D / ${t.losses} L`);
  }
  const score = objective(evaluation, { neverLoseRequired });
  console.log(`objective: ${score}`);
  if (current) {
    const before = objective(current, { neverLoseRequired });
    console.log(`${score > before ? "PROMOTE" : "KEEP"}: ${before} -> ${score}`);
  }
}

const [candidatePath, currentPath] = process.argv.slice(2);
if (!candidatePath) {
  console.error("Usage: tsx evaluate.ts <candidate.json> [current.json]");
  process.exit(1);
}
main(candidatePath, currentPath).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
