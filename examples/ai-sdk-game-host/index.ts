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
  executeAgentRequest,
  initialAgentStep,
  resolveDecision,
  type AgentRequestExecutors,
  type EventUnion,
  resolveAgentStep,
  transitionAgentStep,
} from "../../src/index.js";
import {
  gameActors,
  gameMachine,
  gameSchemas,
  models,
  turnSummarySchema,
} from "../game-agent/index.js";

type GameEvent = EventUnion<typeof gameSchemas.events>;

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
  const decide = executors.decide!;
  let step = initialAgentStep(gameMachine, input, {
    schemas: gameSchemas,
    actorSources: gameActors,
  });
  onStep?.(step.snapshot.value);

  while (!step.done) {
    const [request] = step.requests;
    if (!request) {
      throw new Error("Machine is waiting without an agent request.");
    }

    if (request.kind === "decision") {
      // `resolveDecision` validates the chosen event's payload against the
      // machine's event schemas (attached to `request.events`) and, typed
      // against `GameEvent` via `canTake`, returns a machine-typed event —
      // no re-narrowing needed before `transitionAgentStep`.
      const chosenEvent = await resolveDecision(request, decide, {
        canTake: (event: GameEvent) => step.snapshot.can(event),
      });
      step = transitionAgentStep(gameMachine, step, chosenEvent, {
        schemas: gameSchemas,
        actorSources: gameActors,
      });
      onStep?.(step.snapshot.value);
      continue;
    }

    const output = await executeAgentRequest(request, executors);
    step = resolveAgentStep(gameMachine, step, request, output, {
      schemas: gameSchemas,
      actorSources: gameActors,
    });
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

if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  void main();
}

export { turnSummarySchema };
