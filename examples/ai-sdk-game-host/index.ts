/**
 * Vercel AI SDK host for a non-trivial game workflow — the canonical THIN-loop
 * wiring, driven by the append-only event log.
 *
 * Wiring demonstrated: the host owns the loop. It keeps a journal of external
 * inputs (`entries`), and at each frontier lowers the machine's pending work
 * into an ordered `AgentEffect[]` with `getAgentEffects`. It executes those
 * effects — `text` via `executeAgentRequest`, `decision` via `resolveDecision`
 * — appends each completion to the journal, and folds it back in with xstate's
 * pure `transition`. No `runAgent`, no live actor: just journal → effects →
 * execute → journal → transition. When a frontier has no async effect the
 * machine is idle (persist `entries`, resume later by replaying them).
 *
 * Compare `../ai-sdk-host/index.ts` for the `runAgent`-based wiring, where
 * `runAgent` drives the loop end to end and the host only supplies executors.
 *
 * State machine: ../game-agent/index.ts
 *
 * Run:
 *   OPENAI_API_KEY=... npx tsx examples/ai-sdk-game-host/index.ts
 */
import { initialTransition, transition, type AnyMachineSnapshot, type EventObject } from "xstate";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import { type AgentRequestExecutors } from "@statelyai/agent";
import {
  executeAgentRequest,
  getAgentEffects,
  initEntry,
  resolveDecision,
  type AgentEffect,
} from "@statelyai/agent/steps";
import {
  gameActors,
  gameMachine,
  gameSchemas,
  models,
  turnSummarySchema,
} from "../game-agent/index.js";

// Adapter-provided executors: `decide` forces a tool call, one tool per
// candidate event, and reads the chosen event off the tool call — the
// "tool-per-event + toolChoice: 'required'" recipe from docs/p0-design.md
// §2.6 — how the model is coerced into choosing is adapter business, not
// core's.
const defaultExecutors = createAiSdkExecutors({ models });

// The one host-owned primitive: resolve a single frontier effect into the
// external event to journal, or `undefined` for a fire-and-forget action (run
// now, never journaled — replay re-derives it). A `text` effect resolves with
// the model (`executeAgentRequest`) and journals its done event; a `decision`
// effect resolves with `resolveDecision` (guard-gated by `snapshot.can`) and
// journals the CHOSEN machine event directly. This is all a text/decision
// workflow needs; a task/delay/plan host would add those effect kinds here.
async function resolveEffect(
  effect: AgentEffect,
  snapshot: AnyMachineSnapshot,
  executors: AgentRequestExecutors,
): Promise<EventObject | undefined> {
  if (effect.kind === "execute") {
    effect.exec();
    return undefined;
  }
  if (effect.kind === "text") {
    const output = await executeAgentRequest(effect, executors);
    return effect.toDoneEvent(output);
  }
  if (effect.kind === "decision") {
    if (!executors.decide) {
      throw new Error(`decision effect '${effect.request.id}' needs a 'decide' executor.`);
    }
    return resolveDecision(effect.request, executors.decide, {
      canTake: (event) => snapshot.can(event as never),
    });
  }
  throw new Error(`This game host does not handle '${effect.kind}' effects.`);
}

export async function runAiSdkGameTurn(
  input = { playerHp: 20, enemyHp: 15 },
  onStep?: (value: unknown) => void,
  // Injected so tests drive the turn with mock executors; production uses the
  // AI SDK set above.
  executors: AgentRequestExecutors = defaultExecutors,
) {
  const options = { schemas: gameSchemas, actorSources: gameActors };

  // The journal starts with the reserved init entry carrying the input, so the
  // log is self-contained (a fresh process can `replay` it with no side channel).
  const entries: EventObject[] = [initEntry(input).event];
  let [snapshot, actions] = initialTransition(gameMachine, input);
  onStep?.(snapshot.value);

  while (snapshot.status === "active") {
    const effects = getAgentEffects(gameMachine, snapshot as AnyMachineSnapshot, actions, {
      history: entries,
      ...options,
    });

    // Run fire-and-forget actions inline; resolve the first async effect into
    // the event to journal. One completion per frontier keeps the fold
    // deterministic (the next frontier re-derives what's still owed).
    let next: EventObject | undefined;
    for (const effect of effects) {
      const event = await resolveEffect(effect, snapshot as AnyMachineSnapshot, executors);
      if (event) {
        next = event;
        break;
      }
    }
    if (!next) {
      break; // idle: nothing async owed — persist `entries` and resume later.
    }

    entries.push(next);
    [snapshot, actions] = transition(gameMachine, snapshot, next as never);
    onStep?.(snapshot.value);
  }

  return snapshot.output;
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
