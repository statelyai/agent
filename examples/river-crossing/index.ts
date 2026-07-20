/**
 * River Crossing — the machine as a verifiable environment, with its own
 * rules rendered into the model's context.
 *
 * The classic wolf/goat/cabbage puzzle: a farmer must ferry a wolf, a goat,
 * and a cabbage across a river. The boat holds the farmer plus at most one
 * item. Left alone without the farmer, the wolf eats the goat, or the goat
 * eats the cabbage. Get everything to the right bank.
 *
 * Here the LLM only *proposes* moves; the XState machine is ground truth:
 *   - Machine-as-environment: context holds the true world state (each
 *     item's bank, moves made, the budget). The model never mutates it — it
 *     picks one event and the machine applies the physics.
 *   - Guard-enforced legality: each move is a v6 function-transition that
 *     returns `undefined` when the move is illegal (the item isn't on the
 *     farmer's bank, or the resulting banks would be unsafe). An illegal
 *     choice is rejected by `resolveDecision`'s mode-3 `canTake` check
 *     (`failure: 'rejected-by-guard'`) and retried — same pattern as
 *     twenty-questions' final-turn ASK guard. The model cannot cheat the
 *     rules; it can only learn them.
 *   - Machine-description-in-context: `describeMachine(...)` (an experimental
 *     prototype in ./describe-machine.ts) renders the machine's states, events
 *     (with their payload schemas), transitions, and the puzzle's explicit
 *     rules into compact markdown that is injected into the decide prompt — the
 *     model is handed knowledge of the whole machine it is driving.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/river-crossing/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAgentSchemas, runAgent, type RunAgentOptions, setupAgent } from "@statelyai/agent";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";
import { describeMachine } from "./describe-machine.js";

// Re-exported so the barrel and tests can reach the prototype from this module.
export { describeMachine } from "./describe-machine.js";

const models = defineModels({
  planner: openai("gpt-5.4-mini"),
});

// Bank as a zod enum: `"left"`/`"right"` literals are accepted as `Bank`
// without casts, and `Bank` is the schema's inferred type.
const bankSchema = z.enum(["left", "right"]);
type Bank = z.infer<typeof bankSchema>;

export const riverCrossingSchemas = createAgentSchemas({
  context: z.object({
    farmer: bankSchema,
    wolf: bankSchema,
    goat: bankSchema,
    cabbage: bankSchema,
    moves: z.number(),
    maxMoves: z.number(),
    log: z.array(z.string()),
  }),
  input: z.object({
    maxMoves: z.number().default(12),
  }),
  output: z.object({
    solved: z.boolean(),
    moves: z.number(),
    log: z.array(z.string()),
  }),
  events: {
    TAKE_WOLF: z.object({ reasoning: z.string() }),
    TAKE_GOAT: z.object({ reasoning: z.string() }),
    TAKE_CABBAGE: z.object({ reasoning: z.string() }),
    CROSS_ALONE: z.object({ reasoning: z.string() }),
  },
});

// ─── Puzzle physics (shared by guards and describeMachine) ───

const opposite = (bank: Bank): Bank => (bank === "left" ? "right" : "left");

type Items = "wolf" | "goat" | "cabbage";

// A world schema whose inferred type IS WorldState — one source of truth for
// the farmer + item banks, shared by the tool input and machine context.
const worldStateSchema = z.object({
  farmer: bankSchema,
  wolf: bankSchema,
  goat: bankSchema,
  cabbage: bankSchema,
});
type WorldState = z.infer<typeof worldStateSchema>;

/**
 * True iff no bank holds an unsafe pair without the farmer present:
 * wolf+goat (wolf eats goat) or goat+cabbage (goat eats cabbage).
 */
function isSafe(state: WorldState): boolean {
  const unattended = (bank: Bank) => state.farmer !== bank;
  const together = (a: Items, b: Items, bank: Bank) => state[a] === bank && state[b] === bank;

  for (const bank of ["left", "right"] as const) {
    if (!unattended(bank)) continue;
    if (together("wolf", "goat", bank)) return false;
    if (together("goat", "cabbage", bank)) return false;
  }
  return true;
}

/**
 * Returns the world state after the farmer crosses, optionally carrying one
 * item, or `undefined` if the move is illegal (the item isn't on the farmer's
 * bank, or the crossing leaves an unsafe bank behind).
 */
function applyMove(state: WorldState, item: Items | null): WorldState | undefined {
  if (item && state[item] !== state.farmer) return undefined; // item not on the farmer's bank
  const next: WorldState = { ...state, farmer: opposite(state.farmer) };
  if (item) next[item] = next.farmer;
  return isSafe(next) ? next : undefined;
}

function worldOf(context: { farmer: Bank; wolf: Bank; goat: Bank; cabbage: Bank }): WorldState {
  return {
    farmer: context.farmer,
    wolf: context.wolf,
    goat: context.goat,
    cabbage: context.cabbage,
  };
}

function moveLabel(item: Items | null, from: Bank): string {
  const carried = item ? `the ${item}` : "alone";
  return `Farmer crosses ${from} → ${opposite(from)} with ${carried}`;
}

// ─── Agent + machine ───

const agentSetup = setupAgent({
  schemas: riverCrossingSchemas,
  models,
});

const DECIDE_SYSTEM_PROMPT =
  "You are solving a river-crossing puzzle by driving a state machine. Each " +
  "turn, choose exactly one legal move event. Illegal moves are rejected by " +
  "the machine and you must try again, so reason about safety before choosing.";

function renderWorld(context: {
  farmer: Bank;
  wolf: Bank;
  goat: Bank;
  cabbage: Bank;
  moves: number;
  maxMoves: number;
  log: string[];
}): string {
  return [
    "## Current world state",
    `- farmer: ${context.farmer}`,
    `- wolf: ${context.wolf}`,
    `- goat: ${context.goat}`,
    `- cabbage: ${context.cabbage}`,
    `- moves made: ${context.moves} / ${context.maxMoves}`,
    "",
    "## Moves so far",
    context.log.length === 0
      ? "(none yet)"
      : context.log.map((entry, i) => `${i + 1}. ${entry}`).join("\n"),
    "",
    "Goal: get the farmer, wolf, goat, and cabbage all to the right bank. " +
      "Pick one move event now.",
  ].join("\n");
}

const MACHINE_RULES = [
  "The boat carries the farmer plus at most one item (wolf, goat, or cabbage).",
  "Only the farmer can operate the boat; every crossing flips the farmer's bank.",
  "TAKE_WOLF / TAKE_GOAT / TAKE_CABBAGE ferry that item; it must be on the farmer's current bank.",
  "CROSS_ALONE crosses the farmer with no item.",
  "A move is illegal if it leaves the wolf and goat together, or the goat and cabbage together, on a bank without the farmer.",
  "Solved when farmer, wolf, goat, and cabbage are all on the right bank.",
];

// The machine description is static; render it lazily on first decide (the
// machine `const` is declared below, so it isn't reachable at module eval).
let machineDescription: string | undefined;
function getMachineDescription(): string {
  machineDescription ??= describeMachine(riverCrossingMachine, riverCrossingSchemas, {
    title: "River Crossing",
    rules: MACHINE_RULES,
  });
  return machineDescription;
}

type RiverContext = {
  farmer: Bank;
  wolf: Bank;
  goat: Bank;
  cabbage: Bank;
  moves: number;
  maxMoves: number;
  log: string[];
};

// A move transition: applies the physics, returns `undefined` when illegal so
// the decision's `canTake` check rejects the choice and retries.
function moveTransition(item: Items | null) {
  return ({ context }: { context: RiverContext }) => {
    const next = applyMove(worldOf(context), item);
    if (!next) return undefined; // illegal → rejected-by-guard → retry
    return {
      target: "checkWin",
      context: {
        farmer: next.farmer,
        wolf: next.wolf,
        goat: next.goat,
        cabbage: next.cabbage,
        moves: context.moves + 1,
        log: [...context.log, moveLabel(item, context.farmer)],
      },
    };
  };
}

// True when the farmer, wolf, goat, and cabbage are all on the right bank.
function allOnRight(context: Pick<RiverContext, "farmer" | "wolf" | "goat" | "cabbage">): boolean {
  return (
    context.farmer === "right" &&
    context.wolf === "right" &&
    context.goat === "right" &&
    context.cabbage === "right"
  );
}

export const riverCrossingMachine = agentSetup.createMachine({
  id: "river-crossing",
  // Everything starts on the left bank.
  context: ({ input }): RiverContext => ({
    farmer: "left",
    wolf: "left",
    goat: "left",
    cabbage: "left",
    moves: 0,
    maxMoves: input.maxMoves,
    log: [],
  }),
  // Reports whether the puzzle was solved.
  output: ({ context }) => ({
    solved: allOnRight(context),
    moves: context.moves,
    log: context.log,
  }),
  initial: "deciding",
  states: {
    deciding: {
      invoke: {
        src: "agent.decide",
        input: ({ context }) => ({
          model: "planner",
          system: DECIDE_SYSTEM_PROMPT,
          prompt: `${getMachineDescription()}\n\n${renderWorld(context)}`,
          // Typo'd event names are caught at compile time — allowedEvents is
          // typed against the machine's event-schema keys.
          allowedEvents: ["TAKE_WOLF", "TAKE_GOAT", "TAKE_CABBAGE", "CROSS_ALONE"],
          maxRetries: 3,
        }),
        onError: { target: "failed" },
      },
      on: {
        // Each move is a v6 function-transition. Returning `undefined` makes
        // the transition illegal — `resolveDecision`'s mode-3 `canTake`
        // (snapshot.can(event)) then rejects the choice with
        // `failure: 'rejected-by-guard'` and retries. The model cannot apply
        // an illegal move; the machine owns the physics.
        TAKE_WOLF: moveTransition("wolf"),
        TAKE_GOAT: moveTransition("goat"),
        TAKE_CABBAGE: moveTransition("cabbage"),
        CROSS_ALONE: moveTransition(null),
      },
    },
    // An always function-transition decides the outcome after each applied
    // move: solved when everything is on the right bank, failed when the move
    // budget is spent, otherwise back to deciding.
    checkWin: {
      always: ({ context }: { context: RiverContext }) => {
        if (allOnRight(context)) return { target: "solved" };
        if (context.moves >= context.maxMoves) return { target: "failed" };
        return { target: "deciding" };
      },
    },
    solved: { type: "final" },
    // Reached on move-budget exhaustion or when the decide request exhausts
    // retries.
    failed: {
      type: "final",
      output: ({ context }: { context: RiverContext }) => ({
        solved: false,
        moves: context.moves,
        log: context.log,
      }),
    },
  },
});

// ─── Dual-mode entrypoint ───

export async function runRiverCrossingExample(
  options?: RunAgentOptions<typeof riverCrossingMachine>,
) {
  const result = await runAgent(riverCrossingMachine, {
    input: { maxMoves: 12 },
    ...(options && Object.keys(options).length > 0
      ? options
      : { executors: createAiSdkExecutors({ models }) }),
  });
  if (result.status !== "done") {
    throw new Error(`River crossing did not complete: ${result.status}`);
  }
  return result.output;
}

function printOutcome(output: { solved: boolean; moves: number; log: string[] }) {
  console.log(
    output.solved ? `Solved in ${output.moves} moves:` : `Failed after ${output.moves} moves:`,
  );
  for (const [i, entry] of output.log.entries()) {
    console.log(`  ${i + 1}. ${entry}`);
  }
}

// The model must plan from the machine description alone. It often stumbles
// (illegal moves, extra shuttles) or fails outright — the machine rejects every
// illegal move, so whatever it produces is a genuinely valid solution path.
export async function main() {
  const output = await runRiverCrossingExample();
  printOutcome(output);
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
