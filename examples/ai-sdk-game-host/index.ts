/**
 * Vercel AI SDK step host for a non-trivial game workflow — the explicit
 * step-path wiring.
 *
 * Wiring demonstrated: the host owns the loop. It advances the machine one
 * step at a time with `initialAgentStep` → `resolveAgentStep` (text requests)
 * and `resolveDecision` → `transitionAgentStep` (decision requests), instead
 * of handing everything to `runAgent`. This is the wiring for hosts that need
 * to interleave their own work between steps — decisions, per-turn
 * persistence, or one serverless invocation per turn.
 *
 * Compare `../ai-sdk-host/index.ts` for the `runAgent`-based wiring, where
 * `runAgent` drives the loop end to end and the host only supplies executors.
 *
 * State machine: ../game-agent/index.ts
 *
 * Run:
 *   OPENAI_API_KEY=... npx tsx examples/ai-sdk-game-host/index.ts
 */
import { createAiSdkExecutors } from "../../src/ai-sdk/index.js";
import {
  initialAgentStep,
  resolveAgentRequests,
  type AgentRequestExecutors,
} from "../../src/index.js";
import {
  gameActors,
  gameMachine,
  gameSchemas,
  models,
  turnSummarySchema,
} from "../game-agent/index.js";
import { runExampleMain } from "../helpers/main.js";

// Adapter-provided executors: `decide` forces a tool call, one tool per
// candidate event, and reads the chosen event off the tool call — the
// "tool-per-event + toolChoice: 'required'" recipe from docs/p0-design.md
// §2.6 — how the model is coerced into choosing is adapter business, not
// core's.
const defaultExecutors = createAiSdkExecutors({ models });

export async function runAiSdkGameTurn(
  input = { playerHp: 20, enemyHp: 15 },
  onStep?: (value: unknown) => void,
  // Injected so tests drive the turn with mock executors; production uses the
  // AI SDK set above.
  executors: AgentRequestExecutors = defaultExecutors,
) {
  const options = { schemas: gameSchemas, actorSources: gameActors };
  let step = initialAgentStep(gameMachine, input, options);
  onStep?.(step.snapshot.value);

  // `resolveAgentRequests` collapses the per-turn dispatch: it runs the one
  // pending request (decision → chosen event, or text → summary) and returns
  // the next step. The manual dispatch it replaces — `executeAgentRequest` /
  // `resolveDecision` + `resolveAgentStep` / `transitionAgentStep` — still
  // lives one level down for hosts that need to interleave their own work.
  while (!step.done) {
    step = await resolveAgentRequests(gameMachine, step, executors, options);
    onStep?.(step.snapshot.value);
  }

  return step.snapshot.output;
}

async function main() {
  const output = await runAiSdkGameTurn({ playerHp: 20, enemyHp: 15 }, (value) =>
    console.log("[state]", JSON.stringify(value)),
  );
  console.log(output);
}

runExampleMain(import.meta.url, main);

export { turnSummarySchema };
