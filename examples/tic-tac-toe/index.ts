/**
 * Tic-tac-toe — a policy climbs to a proof that it never loses.
 *
 *   - The ENVIRONMENT (`game.ts`, `ticTacToeMachine`) is a plain XState
 *     machine: zod event schemas (`X.play { cell }`, `O.play { cell }`),
 *     guards for the turn and an empty cell, finals `xWins`, `oWins`, `draw`.
 *     Its root `description` is O's goal. `xTurn` and `oTurn` are idle states
 *     with one interaction choice per cell, so a person can play either side
 *     in the demo.
 *   - The DECIDER plays O at the boundary (`play.ts`): on O's turn the host
 *     calls `decideNext` with `allowedEvents: ["O.play"]` and one payload per
 *     empty cell, and sends the chosen event. X is an opponent function:
 *     random, greedy, or perfect (minimax). Every game is a thread in an
 *     event-log store.
 *   - The POLICY (`policy.ts`, `policies/v0.json`) is a JSON agent workflow
 *     over a fixed vocabulary of low-level board features (`features.ts`):
 *     sorted cell lists such as `completesMyLine` or `createsTheirFork`. It
 *     makes no model calls, so it evaluates synchronously.
 *   - The PROOF (`proof.ts`): `canReach(ticTacToeMachine, "xWins")` with X
 *     exploring every empty cell and O offered only the policy's move.
 *     `reachable: false, complete: true` proves the policy never loses to
 *     ANY X; otherwise the witness is the shortest losing game.
 *   - The CLIMB (`improve.ts`): reflect on the proof's losing games and the
 *     match traces, gate the candidate (`verifyAgentConfig`, the feature
 *     paths, legal moves), and promote only when the objective rises.
 *
 * `runTicTacToeExample` proves v0 (refuted), then climbs `rounds` rounds
 * with a real reflection model and prints each round. The benchmark of raw
 * model, Jev, and the policies lives in `benchmark.ts`.
 *
 * Run: OPENAI_API_KEY=... pnpm exec tsx examples/tic-tac-toe/index.ts
 */
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { openai } from "@ai-sdk/openai";
import type { AgentRequestExecutor } from "@statelyai/agent";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import { improvePolicy, type ImprovementResult } from "./improve.js";
import { loadPolicy, lowerPolicy } from "./policy.js";
import { provePolicy } from "./proof.js";

export { boardFeatures, FEATURES } from "./features.js";
export { GAME_GOAL, ticTacToeMachine, ticTacToeSchemas } from "./game.js";
export { evaluatePolicy, improvePolicy, objective } from "./improve.js";
export { OPPONENTS } from "./opponents.js";
export { decideOMove, playGame, playMatch } from "./play.js";
export { createPolicyDecide, loadPolicy, lowerPolicy, policyMove } from "./policy.js";
export { countLosingLines, provePolicy } from "./proof.js";

const fmt = (value: number) => (Number.isFinite(value) ? value.toFixed(3) : String(value));

/**
 * Proves v0, then hill-climbs from it. Defaults to the AI SDK with OpenAI for
 * the reflection (`OPENAI_API_KEY`); tests pass mock executors.
 */
export async function runTicTacToeExample(
  options: {
    executors?: { generateText: AgentRequestExecutor };
    rounds?: number;
    log?: (line: string) => void;
  } = {},
): Promise<ImprovementResult> {
  const log = options.log ?? console.log;
  const executors =
    options.executors ?? createAiSdkExecutors({ resolveModel: () => openai("gpt-6-luna") });

  const v0 = loadPolicy("v0");
  const proof = await provePolicy(lowerPolicy(v0));
  log(
    proof.neverLoses
      ? `v0 proven in ${Math.round(proof.ms)}ms.`
      : `v0 refuted in ${Math.round(proof.ms)}ms: ${proof.witnessText ?? "no witness"}`,
  );

  const result = await improvePolicy({ current: v0, executors, rounds: options.rounds ?? 4 });
  for (const round of result.rounds) {
    const candidate = round.candidate ? fmt(round.candidate.objective) : "not evaluated";
    const failed = round.gates.find((gate) => !gate.ok);
    log(
      `round ${round.round}: ${round.current.id ?? "policy"} ${fmt(round.objective)} -> ` +
        `${round.proposed?.id ?? "(unnamed)"} ${candidate}: ` +
        `${round.promoted ? "promoted" : `kept (${failed ? `${failed.name}: ${failed.detail}` : "no gain"})`}`,
    );
  }
  const final = await provePolicy(lowerPolicy(result.config));
  log(
    `${result.config.id ?? "final policy"}: ${final.neverLoses ? "PROVEN never to lose" : `refuted: ${final.witnessText ?? "illegal move"}`}`,
  );
  return result;
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
// Run directly: compare canonical file URLs, so a path with `#`, `?` or a
// symlink still matches.
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  runTicTacToeExample().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
