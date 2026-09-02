/**
 * Vercel AI SDK host for a non-trivial game workflow. The machine is the
 * portable artifact; this host contributes only AI SDK executors.
 *
 * State machine: ../game-agent/index.ts
 *
 * Run:
 *   OPENAI_API_KEY=... npx tsx examples/ai-sdk-game-host/index.ts
 */
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import { runAgent, type AgentRequestExecutors } from "@statelyai/agent";
import { gameMachine, models, turnSummarySchema } from "../game-agent/index.js";

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
  const result = await runAgent(gameMachine, {
    input,
    executors,
    onTransition: (snapshot) => onStep?.(snapshot.value),
  });
  if (result.status !== "done") {
    throw new Error(`Game turn ended with ${result.status}.`);
  }
  return result.output;
}

async function main() {
  const output = await runAiSdkGameTurn({ playerHp: 20, enemyHp: 15 }, (value) =>
    console.log("[state]", JSON.stringify(value)),
  );
  console.log(output);
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export { turnSummarySchema };
