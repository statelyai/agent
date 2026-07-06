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
 *   - Machine-description-in-context: `describeMachine(...)` renders the
 *     machine's states, events (with their payload schemas), transitions,
 *     and the puzzle's explicit rules into compact markdown that is injected
 *     into the decide prompt — the model is handed knowledge of the whole
 *     machine it is driving. (Prototype; see the note on `describeMachine`.)
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/river-crossing/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAiSdkExecutors } from "../../src/ai-sdk/index.js";
import {
  createAgentSchemas,
  runAgent,
  type RunAgentOptions,
  sendDecision,
  setupAgent,
} from "../../src/index.js";

type Bank = "left" | "right";

const models = {
  planner: openai("gpt-5.4-mini"),
} as const;

const bankSchema = z.enum(["left", "right"]);

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
type WorldState = Record<"farmer" | Items, Bank>;

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

// ─── describeMachine: render the machine's rules into the model's context ───

/**
 * PROTOTYPE — a hand-rolled renderer of a machine's shape into compact
 * markdown for injection into an LLM prompt.
 *
 * Graph utilities live at the `xstate/graph` subpath in v6 (the standalone
 * `@xstate/graph` package is dead), and a self-contained machine's config
 * serializes to LLM-readable JSON. This prototype stays dependency-free and
 * derives what it can *generically* from `machine.config` (state names,
 * per-state transition event keys, invoke sources, final states) and from the
 * agent {@link AgentSchemaPack} (event payload field names/types). The parts
 * a static graph can't know — *why* a transition is guarded, i.e. the actual
 * legality rules — are passed in as `rules` text by the example.
 *
 * A real core helper (`agent.describe(machine)`?) would need xstate v6 to
 * expose, per transition, a machine-readable guard descriptor (name + human
 * label) rather than an opaque function, so the "unsafe pair" rules below
 * could be derived instead of hand-written. Until then this stays example-
 * local and honest about the split.
 */
export function describeMachine(
  machine: { config: { id?: string; initial?: unknown; states?: Record<string, unknown> } },
  schemas: { events: Record<string, unknown> },
  extra?: { title?: string; rules?: string[] },
): string {
  const config = machine.config;
  const states = config.states ?? {};
  const lines: string[] = [];

  lines.push(`# ${extra?.title ?? config.id ?? "machine"}`);
  if (extra?.rules?.length) {
    lines.push("", "## Rules", ...extra.rules.map((rule) => `- ${rule}`));
  }

  lines.push("", "## Events (each carries a `reasoning` string)");
  for (const [name, schema] of Object.entries(schemas.events)) {
    lines.push(`- **${name}**${renderEventFields(schema)}`);
  }

  lines.push("", "## States");
  for (const [name, node] of Object.entries(states) as [string, StateNodeShape][]) {
    const parts: string[] = [];
    if (name === config.initial) parts.push("initial");
    if (node?.type === "final") parts.push("final");
    const invokeSrc = typeof node?.invoke?.src === "string" ? node.invoke.src : undefined;
    if (invokeSrc) parts.push(`invokes \`${invokeSrc}\``);
    const events = node?.on ? Object.keys(node.on) : [];
    if (events.length) parts.push(`accepts ${events.map((event) => `\`${event}\``).join(", ")}`);
    lines.push(`- **${name}**${parts.length ? ` — ${parts.join("; ")}` : ""}`);
  }

  return lines.join("\n");
}

interface StateNodeShape {
  type?: string;
  invoke?: { src?: unknown };
  on?: Record<string, unknown>;
}

// Renders a zod event schema's non-`reasoning` fields as `(field: type, …)`.
// Best-effort against zod v4's `.shape` / `._def.type`; empty when only
// `reasoning` is present.
function renderEventFields(schema: unknown): string {
  const shape = (schema as { shape?: Record<string, unknown> })?.shape;
  if (!shape) return "";
  const fields = Object.entries(shape)
    .filter(([key]) => key !== "reasoning")
    .map(([key, field]) => `${key}: ${zodTypeName(field)}`);
  return fields.length ? ` (${fields.join(", ")})` : "";
}

function zodTypeName(field: unknown): string {
  const def = (field as { _def?: { type?: string; typeName?: string } })?._def;
  return def?.type ?? def?.typeName ?? "value";
}

// ─── Agent + machine ───

const agent = setupAgent({
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

// A move transition: applies the physics, returns `undefined` when illegal so
// the decision's `canTake` check rejects the choice and retries.
function moveTransition(item: Items | null) {
  return ({
    context,
  }: {
    context: {
      farmer: Bank;
      wolf: Bank;
      goat: Bank;
      cabbage: Bank;
      moves: number;
      maxMoves: number;
      log: string[];
    };
  }) => {
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

export const riverCrossingMachine = agent.createMachine({
  id: "river-crossing",
  context: ({ input }) => ({
    farmer: "left" as Bank,
    wolf: "left" as Bank,
    goat: "left" as Bank,
    cabbage: "left" as Bank,
    moves: 0,
    maxMoves: input.maxMoves,
    log: [],
  }),
  output: ({ context }) => ({
    solved:
      context.farmer === "right" &&
      context.wolf === "right" &&
      context.goat === "right" &&
      context.cabbage === "right",
    moves: context.moves,
    log: context.log,
  }),
  initial: "deciding",
  states: {
    deciding: {
      invoke: {
        id: "chooseMove",
        src: "agent.decide",
        input: ({ context }) => ({
          model: "planner",
          system: DECIDE_SYSTEM_PROMPT,
          prompt: `${getMachineDescription()}\n\n${renderWorld(context)}`,
          // Typo'd event names are caught at compile time — allowedEvents is
          // typed against the machine's event-schema keys.
          allowedEvents: ["TAKE_WOLF", "TAKE_GOAT", "TAKE_CABBAGE", "CROSS_ALONE"] as const,
          maxRetries: 3,
        }),
        onDone: sendDecision(),
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
      always: ({ context }) => {
        const allRight =
          context.farmer === "right" &&
          context.wolf === "right" &&
          context.goat === "right" &&
          context.cabbage === "right";
        if (allRight) return { target: "solved" };
        if (context.moves >= context.maxMoves) return { target: "failed" };
        return { target: "deciding" };
      },
    },

    solved: { type: "final" },

    // Reached on move-budget exhaustion or when chooseMove exhausts retries.
    failed: {
      type: "final",
      output: ({ context }) => ({
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
    ...(options ?? { ...createAiSdkExecutors({ models }) }),
  });
  if (result.status !== "done") {
    throw new Error(`River crossing did not complete: ${result.status}`);
  }
  return result.output;
}

export async function main() {
  const output = await runRiverCrossingExample();
  console.log(
    output.solved ? `Solved in ${output.moves} moves:` : `Failed after ${output.moves} moves:`,
  );
  for (const [i, entry] of output.log.entries()) {
    console.log(`  ${i + 1}. ${entry}`);
  }
}

if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  void main();
}
