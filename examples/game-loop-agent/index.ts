/**
 * Game loop agent — a long-lived player agent invoked by a game machine.
 *
 * The game is Pig: on your turn you roll a die repeatedly, adding each roll to
 * a turn total, but rolling a 1 wipes the turn total and ends the turn. Banking
 * moves the turn total into your score. First to the target wins the round.
 *
 * Showcases:
 *   - Long-lived invoked agent. The player agent machine is invoked on the
 *     `playing` compound state, not on a per-turn substate. It stays alive
 *     across every substate transition (your turn, my turn, round over, next
 *     round), keeping its accumulated observations — including across idle
 *     settles, because resumes use the result's `persistedSnapshot`, which
 *     round-trips invoked children with their state.
 *   - Pushed game state. The game machine forwards what happens as it happens
 *     via `OBSERVE` events (opponent rolls, busts, banks, round results). The
 *     agent handles those at its root, in any state.
 *   - Turn-gated action. The agent only moves when it receives `YOUR_TURN`, at
 *     which point `agent.decide` picks one currently-legal event. BANK is
 *     illegal with an empty turn total (the transition returns `undefined`), so
 *     the guard rejects it and the decision retries.
 *   - Human moves as gated machine events with `meta.interaction` hints, so
 *     hosts/demos drive them as buttons (`HUMAN_ROLL` / `HUMAN_BANK`) and a
 *     free-text box (`ROUND_REPLY`). The run settles idle on those states and
 *     resumes with `runAgent(machine, { snapshot: persistedSnapshot, event })`.
 *   - Natural-language round control. The free-text round reply is interpreted
 *     with a structured-output request.
 *
 * Dual-mode: `runGameLoopExample(options?)` takes injectable executors and
 * scripted human events (the test passes mocks, so CI stays keyless); the
 * direct run below uses real models and stdin.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/game-loop-agent/index.ts
 */
import { z } from "zod";
import type { InspectionEvent, SnapshotFrom } from "xstate";
import { openai } from "@ai-sdk/openai";
import {
  getStateMeta,
  runAgent,
  setupAgent,
  type AgentDecisionExecutor,
  type AgentRequestExecutor,
} from "@statelyai/agent";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";

export const models = defineModels({
  player: openai("gpt-5.4-mini"),
  referee: openai("gpt-5.4-mini"),
});

const DEFAULT_TARGET = 50;
const DEFAULT_MAX_ROUNDS = 3;

/** Deterministic die so rounds replay identically in tests. */
function rollDie(seed: number): { value: number; seed: number } {
  const next = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
  return { value: (next % 6) + 1, seed: next };
}

// ─── Player agent: watches always, moves only on its turn ───

const turnStateSchema = z.object({
  turnTotal: z.number(),
  myScore: z.number(),
  opponentScore: z.number(),
  target: z.number(),
});

const playerAgentSetup = setupAgent({
  models,
  context: z.object({
    notes: z.array(z.string()),
    turn: turnStateSchema.nullable(),
  }),
  events: {
    /** Pushed by the game machine whenever anything happens. */
    OBSERVE: z.object({ note: z.string() }),
    /** Pushed when it is the agent's move. */
    YOUR_TURN: turnStateSchema,
    ROLL: z.object({}),
    BANK: z.object({}),
  },
});

export const playerAgentMachine = playerAgentSetup.createMachine({
  id: "pig-player",
  context: { notes: [], turn: null },
  // Root-level handler: observations land in any state, including mid-decision.
  on: {
    OBSERVE: ({ context, event }) => ({
      context: { notes: [...context.notes, event.note].slice(-40) },
    }),
  },
  initial: "watching",
  states: {
    watching: {
      on: {
        YOUR_TURN: ({ event }) => ({
          target: "deciding",
          context: {
            turn: {
              turnTotal: event.turnTotal,
              myScore: event.myScore,
              opponentScore: event.opponentScore,
              target: event.target,
            },
          },
        }),
      },
    },
    deciding: {
      invoke: {
        src: "agent.decide",
        input: ({ context }) => ({
          model: "player",
          system:
            "You are playing Pig. Rolling adds the die value to your turn total, but a 1 " +
            "wipes the turn total and ends your turn. Banking adds the turn total to your " +
            "score. Play to win: push harder when behind, bank earlier when ahead.",
          prompt: [
            `Turn total: ${context.turn?.turnTotal ?? 0}`,
            `Your score: ${context.turn?.myScore ?? 0} / ${context.turn?.target ?? DEFAULT_TARGET}`,
            `Opponent score: ${context.turn?.opponentScore ?? 0}`,
            "What you have observed:",
            context.notes.length === 0 ? "(nothing yet)" : context.notes.join("\n"),
            "Choose ROLL or BANK.",
          ].join("\n"),
          maxRetries: 2,
        }),
        // A dead decision loop should not stall the game: fall back to banking.
        onError: ({ parent }, enq) => {
          if (parent) enq.sendTo(parent, { type: "AGENT_MOVE", move: "bank" });
          return { target: "watching", context: { turn: null } };
        },
      },
      on: {
        ROLL: ({ parent }, enq) => {
          if (parent) enq.sendTo(parent, { type: "AGENT_MOVE", move: "roll" });
          return { target: "watching", context: { turn: null } };
        },
        // Illegal with nothing banked yet — the guard rejects the choice and
        // `agent.decide` retries.
        BANK: ({ context, parent }, enq) => {
          if ((context.turn?.turnTotal ?? 0) <= 0) return undefined;
          if (parent) enq.sendTo(parent, { type: "AGENT_MOVE", move: "bank" });
          return { target: "watching", context: { turn: null } };
        },
      },
    },
  },
});

// ─── Game machine: owns rounds, turn order, and the die ───

/**
 * Typed `meta.interaction` hints. Hosts read them off the idle snapshot to
 * label buttons and route free chat text to an event.
 */
const metaSchema = z.object({
  interaction: z
    .object({
      label: z.string(),
      events: z
        .record(
          z.string(),
          z.object({
            label: z.string().optional(),
            style: z.enum(["primary", "danger", "default"]).optional(),
          }),
        )
        .optional(),
      textEvent: z.string().optional(),
    })
    .optional(),
});

const gameSetup = setupAgent({
  models,
  meta: metaSchema,
  context: z.object({
    seed: z.number(),
    target: z.number(),
    maxRounds: z.number(),
    round: z.number(),
    starter: z.enum(["human", "agent"]),
    humanScore: z.number(),
    agentScore: z.number(),
    turnTotal: z.number(),
    humanWins: z.number(),
    agentWins: z.number(),
    notice: z.string(),
    pendingReply: z.string(),
  }),
  input: z.object({
    seed: z.number().int().default(11),
    target: z.number().int().positive().default(DEFAULT_TARGET),
    maxRounds: z.number().int().positive().default(DEFAULT_MAX_ROUNDS),
  }),
  output: z.object({
    rounds: z.number(),
    humanWins: z.number(),
    agentWins: z.number(),
    reason: z.enum(["user-stopped", "round-limit"]),
  }),
  events: {
    AGENT_MOVE: z.object({ move: z.enum(["roll", "bank"]) }),
    /** Human moves, gated by the current state (BANK needs a turn total). */
    HUMAN_ROLL: z.object({}),
    HUMAN_BANK: z.object({}),
    /** Free-text answer to "another round?", classified by the referee. */
    ROUND_REPLY: z.object({ reply: z.string() }),
  },
  actors: { player: playerAgentMachine },
  requests: {
    classifyRoundControl: {
      schemas: {
        input: z.object({ reply: z.string(), standings: z.string() }),
        output: z.object({
          playAgain: z.boolean(),
          reasoning: z.string(),
        }),
      },
      model: "referee",
      system:
        "Decide whether the player wants another round of Pig. Return playAgain=true for " +
        'anything affirmative ("sure", "one more", "go on"), false for anything that ' +
        'signals stopping ("i\'m done", "nah", "that\'s enough"). Keep reasoning short.',
      prompt: ({ input }) =>
        [`Standings: ${input.standings}`, `Reply to "another round?": ${input.reply}`].join("\n"),
    },
  },
});

interface GameContext {
  seed: number;
  target: number;
  maxRounds: number;
  round: number;
  starter: "human" | "agent";
  humanScore: number;
  agentScore: number;
  turnTotal: number;
  humanWins: number;
  agentWins: number;
  notice: string;
  pendingReply: string;
}

/** Apply one move for `who`; returns the next context plus what to do next. */
function applyMove(context: GameContext, who: "human" | "agent", move: "roll" | "bank") {
  if (move === "bank") {
    const gained = context.turnTotal;
    const humanScore = context.humanScore + (who === "human" ? gained : 0);
    const agentScore = context.agentScore + (who === "agent" ? gained : 0);
    const note = `${who} banked ${gained} (human ${humanScore}, agent ${agentScore})`;
    const won = (who === "human" ? humanScore : agentScore) >= context.target;
    return {
      context: { ...context, humanScore, agentScore, turnTotal: 0, notice: note },
      note,
      next: won ? ("roundOver" as const) : ("handOver" as const),
    };
  }

  const { value, seed } = rollDie(context.seed);
  if (value === 1) {
    const note = `${who} rolled a 1 and busted`;
    return {
      context: { ...context, seed, turnTotal: 0, notice: note },
      note,
      next: "handOver" as const,
    };
  }
  const turnTotal = context.turnTotal + value;
  const note = `${who} rolled ${value} (turn total ${turnTotal})`;
  return {
    context: { ...context, seed, turnTotal, notice: note },
    note,
    next: "sameTurn" as const,
  };
}

function standings(context: GameContext) {
  return `round ${context.round}: human ${context.humanWins} wins, agent ${context.agentWins} wins`;
}

function humanPrompt(context: GameContext) {
  return [
    context.notice,
    `Scores — you ${context.humanScore}, agent ${context.agentScore} (target ${context.target})`,
    `Turn total: ${context.turnTotal}`,
    "Roll or bank?",
  ].join("\n");
}

function freshRound(context: GameContext, winner: "human" | "agent"): GameContext {
  const starter = context.starter === "human" ? "agent" : "human";
  return {
    ...context,
    round: context.round + 1,
    starter,
    humanScore: 0,
    agentScore: 0,
    turnTotal: 0,
    humanWins: context.humanWins + (winner === "human" ? 1 : 0),
    agentWins: context.agentWins + (winner === "agent" ? 1 : 0),
    pendingReply: "",
    notice: `New round. ${starter} starts.`,
  };
}

function roundWinner(context: GameContext): "human" | "agent" {
  return context.humanScore >= context.target ? "human" : "agent";
}

export const gameMachine = gameSetup.createMachine({
  id: "pig-game",
  context: ({ input }) => ({
    seed: input.seed,
    target: input.target,
    maxRounds: input.maxRounds,
    round: 1,
    starter: "human" as const,
    humanScore: 0,
    agentScore: 0,
    turnTotal: 0,
    humanWins: 0,
    agentWins: 0,
    notice: "Round 1. You start.",
    pendingReply: "",
  }),
  initial: "playing",
  states: {
    playing: {
      // The headline: one player agent for the whole match, invoked here and
      // not on any substate, so it survives every turn and round transition.
      invoke: {
        id: "player",
        src: "player",
      },
      initial: "humanTurn",
      states: {
        // No invoke: the run settles idle here and a host resumes with one of
        // the accepted events. `meta.interaction` labels them as buttons.
        humanTurn: {
          tags: ["waiting"],
          meta: {
            interaction: {
              label: "{notice} Your turn. Roll or bank?",
              events: {
                HUMAN_ROLL: { label: "Roll", style: "primary" },
                HUMAN_BANK: { label: "Bank" },
              },
            },
          },
          on: {
            HUMAN_ROLL: ({ context, children }, enq) => {
              const result = applyMove(context, "human", "roll");
              // Push the move to the agent as it happens, whatever state it is in.
              enq.sendTo(children.player, { type: "OBSERVE", note: result.note });
              return {
                target: result.next === "sameTurn" ? "humanTurn" : "agentTurn",
                context: result.context,
              };
            },
            // Illegal with nothing accrued — same constraint the agent has.
            HUMAN_BANK: ({ context, children }, enq) => {
              if (context.turnTotal <= 0) return undefined;
              const result = applyMove(context, "human", "bank");
              enq.sendTo(children.player, { type: "OBSERVE", note: result.note });
              return {
                target: result.next === "roundOver" ? "roundOver" : "agentTurn",
                context: result.context,
              };
            },
          },
        },
        agentTurn: {
          always: ({ context, children }, enq) => {
            enq.sendTo(children.player, {
              type: "YOUR_TURN",
              turnTotal: context.turnTotal,
              myScore: context.agentScore,
              opponentScore: context.humanScore,
              target: context.target,
            });
            return { target: "awaitingAgentMove" };
          },
        },
        awaitingAgentMove: {
          on: {
            AGENT_MOVE: ({ context, event, children }, enq) => {
              const result = applyMove(context, "agent", event.move);
              enq.sendTo(children.player, { type: "OBSERVE", note: result.note });
              return {
                target:
                  result.next === "sameTurn"
                    ? "agentTurn"
                    : result.next === "handOver"
                      ? "humanTurn"
                      : "roundOver",
                context: result.context,
              };
            },
          },
        },
        roundOver: {
          always: ({ context, children }, enq) => {
            const winner = roundWinner(context);
            enq.sendTo(children.player, {
              type: "OBSERVE",
              note: `Round ${context.round} won by ${winner}.`,
            });
            return { target: "askingNextRound", context: { notice: `${winner} won the round.` } };
          },
        },
        // Idle again, but for free text: the host sends the typed reply as
        // ROUND_REPLY and the referee classifies it.
        askingNextRound: {
          tags: ["waiting"],
          meta: {
            interaction: {
              // `{notice}` resolves against the snapshot's context when the
              // label is shown (host convention; meta itself is static), so
              // the question can say who won: "agent won the round. Another…".
              label: "{notice} Another round, or call it here?",
              textEvent: "ROUND_REPLY",
              events: { ROUND_REPLY: { label: "Reply", style: "primary" } },
            },
          },
          on: {
            ROUND_REPLY: ({ event }) => ({
              target: "classifyingNextRound",
              context: { pendingReply: event.reply },
            }),
          },
        },
        classifyingNextRound: {
          invoke: {
            src: "classifyRoundControl",
            input: ({ context }) => ({
              reply: context.pendingReply,
              standings: standings(context),
            }),
            onDone: ({ context, output }) => {
              const winner = roundWinner(context);
              if (!output.playAgain) {
                return {
                  target: "#pig-game.stopped",
                  context: {
                    humanWins: context.humanWins + (winner === "human" ? 1 : 0),
                    agentWins: context.agentWins + (winner === "agent" ? 1 : 0),
                  },
                };
              }
              const next = freshRound(context, winner);
              // Round limit ends the match even if the user keeps saying yes.
              return next.round > context.maxRounds
                ? {
                    target: "#pig-game.roundLimit",
                    context: {
                      humanWins: next.humanWins,
                      agentWins: next.agentWins,
                      round: context.round,
                    },
                  }
                : {
                    target: next.starter === "human" ? "humanTurn" : "agentTurn",
                    context: next,
                  };
            },
            // If the classifier fails, stop rather than loop forever.
            onError: ({ context }) => {
              const winner = roundWinner(context);
              return {
                target: "#pig-game.stopped",
                context: {
                  humanWins: context.humanWins + (winner === "human" ? 1 : 0),
                  agentWins: context.agentWins + (winner === "agent" ? 1 : 0),
                },
              };
            },
          },
        },
      },
    },
    stopped: {
      type: "final",
      output: ({ context }) => ({
        rounds: context.round,
        humanWins: context.humanWins,
        agentWins: context.agentWins,
        reason: "user-stopped" as const,
      }),
    },
    roundLimit: {
      type: "final",
      output: ({ context }) => ({
        rounds: context.round,
        humanWins: context.humanWins,
        agentWins: context.agentWins,
        reason: "round-limit" as const,
      }),
    },
  },
});

/** What a host (or the test) sends to unblock an idle game machine. */
export type HumanEvent =
  | { type: "HUMAN_ROLL" }
  | { type: "HUMAN_BANK" }
  | { type: "ROUND_REPLY"; reply: string };

type GameSnapshot = SnapshotFrom<typeof gameMachine>;

/** Turns free text into the event the idle state accepts. */
export function toHumanEvent(snapshot: GameSnapshot, text: string): HumanEvent {
  if (snapshot.can({ type: "ROUND_REPLY", reply: text })) {
    return { type: "ROUND_REPLY", reply: text };
  }
  return /\b(bank|hold|stop|stay)\b/i.test(text) ? { type: "HUMAN_BANK" } : { type: "HUMAN_ROLL" };
}

export async function runGameLoopExample(options?: {
  input?: { seed?: number; target?: number; maxRounds?: number };
  decide?: AgentDecisionExecutor;
  generateText?: AgentRequestExecutor;
  /** Scripted human events, consumed in order on each idle settle. */
  humanEvents?: HumanEvent[];
  /** Or decide per idle snapshot; falls back to `humanEvents`, then stdin. */
  nextHumanEvent?: (snapshot: GameSnapshot) => HumanEvent | undefined;
  onNotice?: (notice: string) => void;
  /**
   * xstate inspection passthrough. The stream covers the whole actor system,
   * so one inspector sees both the game machine and the invoked player agent
   * (and their decide invokes) as separate actors.
   */
  inspect?: (inspectionEvent: InspectionEvent) => void;
}) {
  const mocked = options?.decide ?? options?.generateText;
  let lastNotice = "";
  const queued = [...(options?.humanEvents ?? [])];

  const shared = {
    executors: mocked
      ? {
          ...(options?.decide ? { decide: options.decide } : {}),
          ...(options?.generateText ? { generateText: options.generateText } : {}),
        }
      : createAiSdkExecutors({ models }),
    actors: { player: playerAgentMachine },
    // NOTE: no `isSuspended` here yet — with a declared suspension predicate,
    // the settle path loses the invoked player's accumulated context (library
    // bug, tracked in "Fix child-state loss in isSuspended settle path").
    // Re-enable as `(s: AnyMachineSnapshot) => s.hasTag("waiting")` once fixed.
    ...(options?.inspect ? { inspect: options.inspect } : {}),
    onTransition: (snapshot: GameSnapshot) => {
      if (snapshot.context.notice !== lastNotice) {
        lastNotice = snapshot.context.notice;
        options?.onNotice?.(lastNotice);
      }
    },
  };

  let result = await runAgent(gameMachine, {
    input: {
      seed: options?.input?.seed ?? 11,
      target: options?.input?.target ?? DEFAULT_TARGET,
      maxRounds: options?.input?.maxRounds ?? DEFAULT_MAX_ROUNDS,
    },
    ...shared,
  });

  // Every human move settles the run idle. Resume from `persistedSnapshot` —
  // it round-trips the invoked `player` child WITH its accumulated
  // observations (the live `snapshot` would restart the child fresh).
  while (result.status === "idle") {
    const event =
      options?.nextHumanEvent?.(result.snapshot) ??
      queued.shift() ??
      toHumanEvent(result.snapshot, await promptLine(`${idlePrompt(result.snapshot)}\n> `));
    result = await runAgent(gameMachine, {
      snapshot: result.persistedSnapshot,
      event,
      ...shared,
    });
  }

  if (result.status !== "done") {
    throw new Error(`Game loop example did not complete: ${result.status}`);
  }
  return result.output;
}

/** `{key}` placeholders in interaction labels resolve against context. */
export function resolveInteractionLabel(label: string, context: Record<string, unknown>): string {
  return label
    .replace(/\{(\w+)\}/g, (_, key: string) => {
      const value = context[key];
      return typeof value === "string" || typeof value === "number" ? String(value) : "";
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** Stdin prompt for whatever the idle state is waiting on. */
function idlePrompt(snapshot: GameSnapshot): string {
  const interaction = getStateMeta(snapshot).interaction;
  return snapshot.can({ type: "ROUND_REPLY", reply: "" })
    ? resolveInteractionLabel(interaction?.label ?? "Another round?", snapshot.context)
    : humanPrompt(snapshot.context);
}

/** Prompt once on stdin and resolve the trimmed reply. */
async function promptLine(query: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(query)).trim();
  } finally {
    rl.close();
  }
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  void (async () => {
    const output = await runGameLoopExample({
      onNotice: (notice) => console.log(`[game] ${notice}`),
    });
    console.log(output);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
