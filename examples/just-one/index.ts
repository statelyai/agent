/**
 * Just One — three AI clue-givers write at the same time, in the dark, and the
 * machine (not the prompt) throws away the clues that collide.
 *
 * The cooperative party game: a human guesser must name a secret word from
 * one-word clues written by the other players. Every clue that matches another
 * player's clue is struck before the guesser ever sees it — so the players win
 * by writing clues that are accurate but *not* the obvious one.
 *
 * Two properties this example exists to show:
 *
 *   1. Isolation is architectural, not promised. The three clue-givers are
 *      regions of one `type: 'parallel'` state, and each region's request input
 *      is built by `({ context }) => ({ secretWord, persona })` — two fields,
 *      neither of which is a sibling's clue. All three inputs are constructed
 *      when `cluing` is entered, before any request settles, so there is no
 *      point in the run at which one giver's clue could reach another's prompt.
 *      Each region writes only its OWN context slot (`clueA` / `clueB` /
 *      `clueC`) and reads none of the others. A prompt saying "don't peek" is a
 *      request; this is a fact about the graph, and `index.test.ts` regression-
 *      tests it by asserting no captured request text contains another giver's
 *      clue.
 *
 *      Theory of mind still lives in the model: each giver is told that two
 *      other players are writing simultaneously and that duplicates cancel, so
 *      it must *reason about* what the others will likely write. It just never
 *      gets to see it.
 *
 *   2. The rules are machine-owned. Normalization, the duplicate strike, the
 *      "clue is the secret word" strike, the "one word only" strike, and the
 *      all-clues-struck round skip are pure functions applied in the
 *      `judging` transition. The model cannot talk its way past them, and they
 *      hold identically whether the clues came from a real model or the
 *      scripted executors in the tests.
 *
 *   3. The guesser never sees the answer early. The secret word is not a
 *      context field — it is derived from the deck and the round index
 *      (`secretWordOf`) — and a struck clue is stored face down (its word
 *      blanked), because a struck clue may BE the secret. The round's log line,
 *      which names the word, is written only after the guess. Everything a host
 *      can render from context while the guesser thinks is safe to show.
 *
 * The guesser's turn is an idle state (no invoke) carrying `meta.interaction`:
 * the surviving clues in the label, free text routed to `GUESS`, and a `PASS`
 * button. Resume with
 * `runAgent(machine, { snapshot: result.persist(), event })`.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/just-one/index.ts
 */
import { z } from "zod";
import type { SnapshotFrom } from "xstate";
import { openai } from "@ai-sdk/openai";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import {
  createAgentSchemas,
  getInteraction,
  interactionMetaSchema,
  createAgentRuntime,
  runToQuiescence,
  setupAgent,
} from "@statelyai/agent";

/** Concrete, guessable words. Rounds take them in order, so runs are repeatable. */
export const WORD_DECK = [
  "piano",
  "volcano",
  "honey",
  "pirate",
  "cactus",
  "lighthouse",
  "penguin",
  "guitar",
  "pyramid",
  "umbrella",
  "dragon",
  "telescope",
] as const;

const personaSchema = z.object({
  name: z.string(),
  angle: z.string(),
});
type Persona = z.infer<typeof personaSchema>;

/**
 * Three angles on the same word. Flavor, not enforcement: differing angles make
 * collisions less likely, but nothing stops two givers from landing on the same
 * word — that is exactly the case the machine handles.
 */
export const PERSONAS = [
  {
    name: "Iris",
    angle: "free-associate — the first vivid image the word brings to mind",
  },
  {
    name: "Milo",
    angle: "think in categories, materials, and parts of things",
  },
  {
    name: "Nadia",
    angle: "think of a famous example, place, or story the word belongs to",
  },
] as const satisfies readonly Persona[];

/**
 * A clue-giver's draft: the clue word and nothing else. No `reasoning` field —
 * any reasoning about a clue names the secret, and the request's output
 * travels in its done event, which a host may render (a transition log) while
 * the guesser is still thinking.
 */
const clueDraftSchema = z.object({
  clue: z.string().describe("Your one-word clue, and nothing else."),
});
type ClueDraft = z.infer<typeof clueDraftSchema>;

const judgedClueSchema = z.object({
  author: z.string(),
  word: z.string(),
  struck: z.boolean(),
  reason: z.string(),
});
type JudgedClue = z.infer<typeof judgedClueSchema>;

const contextSchema = z.object({
  deck: z.array(z.string()),
  roundIndex: z.number(),
  rounds: z.number(),
  /**
   * One slot per clue-giver. A region writes only its own slot; no region
   * reads another's. Separate fields (rather than one array) keep the three
   * concurrent context writes provably disjoint.
   */
  clueA: clueDraftSchema.nullable(),
  clueB: clueDraftSchema.nullable(),
  clueC: clueDraftSchema.nullable(),
  /**
   * The judged clues of the current round, struck flags included. Struck clues
   * are face down: their `word` is blanked (see `faceDown`).
   */
  clues: z.array(judgedClueSchema),
  score: z.number(),
  log: z.array(z.string()),
});
type JustOneContext = z.infer<typeof contextSchema>;

export const justOneSchemas = createAgentSchemas({
  // The shipped schema for `meta.interaction`: hosts read the label, the
  // buttons, and the free-text event off the idle snapshot with
  // `getInteraction(snapshot)`.
  meta: interactionMetaSchema,
  context: contextSchema,
  input: z.object({
    rounds: z.number().int().positive().default(3),
    /** Override the built-in deck (the tests pin the secret words this way). */
    deck: z.array(z.string()).optional(),
  }),
  output: z.object({
    /**
     * Headline: a readable round-by-round narration of the game — the score,
     * then one log line per line. The log is not repeated as its own field.
     */
    summary: z.string(),
    score: z.number(),
    rounds: z.number(),
  }),
  events: {
    /** The guesser's answer, sent by a host as free text. */
    GUESS: z.object({ guess: z.string() }),
    PASS: z.object({}),
  },
});

const models = { clueGiver: openai("gpt-5.4-mini") };

// ─── Rules (pure functions — the machine's, not the prompt's) ───

/** Lowercase, strip accents and punctuation, collapse whitespace. */
export function normalizeWord(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Naive de-inflection so "keys" and "key" collide. */
function singularize(word: string): string {
  if (word.length > 3 && word.endsWith("es")) return word.slice(0, -2);
  return word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word;
}

/** The comparison key: two clues collide iff their keys are equal. */
export function clueKey(raw: string): string {
  return singularize(normalizeWord(raw));
}

/**
 * Apply the whole rulebook to one round's drafts. Every strike is decided here,
 * deterministically, from the drafts plus the secret word:
 *
 * - empty draft (a failed request) is struck;
 * - a clue that is not a single word is struck;
 * - a clue that is the secret word, or contains it, is struck;
 * - clues sharing a key with any other clue cancel each other.
 *
 * Duplicates are counted across every non-empty clue, including ones already
 * struck for another reason — a rule violation does not shield a sibling.
 */
export function judgeClues(secretWord: string, drafts: (ClueDraft | null)[]): JudgedClue[] {
  const secretKey = clueKey(secretWord);
  const entries = drafts.map((draft, index) => ({
    author: PERSONAS[index]?.name ?? `Player ${index + 1}`,
    word: draft?.clue.trim() ?? "",
    normalized: normalizeWord(draft?.clue ?? ""),
  }));

  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.normalized) continue;
    const key = clueKey(entry.word);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return entries.map(({ author, word, normalized }) => {
    const key = clueKey(word);
    if (!normalized) {
      return { author, word, struck: true, reason: "no clue written" };
    }
    if (normalized.includes(" ")) {
      return { author, word, struck: true, reason: "not a single word" };
    }
    if (key === secretKey || key.includes(secretKey)) {
      return { author, word, struck: true, reason: "gives away the secret word" };
    }
    if ((counts.get(key) ?? 0) > 1) {
      return { author, word, struck: true, reason: "duplicate — cancelled" };
    }
    return { author, word, struck: false, reason: "" };
  });
}

/** `true` when the guess matches the secret word after normalization. */
export function isCorrectGuess(guess: string, secretWord: string): boolean {
  return clueKey(guess) === clueKey(secretWord) && clueKey(secretWord) !== "";
}

/**
 * The round's secret word: the deck card at the round index. Derived rather
 * than stored, so no context field the guesser might be shown ever holds it.
 */
export function secretWordOf(context: { deck: string[]; roundIndex: number }): string {
  return context.deck[context.roundIndex % context.deck.length] ?? "";
}

/**
 * Turn struck clues face down, as in the real game: the guesser never sees a
 * struck word — and one struck for giving the word away would spoil the round.
 */
export function faceDown(clues: JudgedClue[]): JudgedClue[] {
  return clues.map((clue) => (clue.struck ? { ...clue, word: "" } : clue));
}

function renderClues(clues: JudgedClue[]): string {
  return clues
    .map((clue) =>
      clue.struck ? `[${clue.author}: ${clue.reason}]` : `${clue.word} (${clue.author})`,
    )
    .join(", ");
}

/** The round's log line. It names the secret, so it is written after the guess. */
function roundLine(context: JustOneContext): string {
  return (
    `Round ${context.roundIndex + 1} — secret "${secretWordOf(context)}". ` +
    `Clues: ${renderClues(context.clues)}.`
  );
}

function survivors(clues: JudgedClue[]): JudgedClue[] {
  return clues.filter((clue) => !clue.struck);
}

/** Joins the log into readable prose for the machine output. */
function narrate(context: { log: string[]; score: number; rounds: number }): string {
  const headline = `Guessed ${context.score} of ${context.rounds} word${
    context.rounds === 1 ? "" : "s"
  }.`;
  const body = context.log.length === 0 ? "No rounds played." : context.log.join("\n");
  return `${headline}\n\n${body}`;
}

// ─── Agent ───

const CLUE_SYSTEM_PROMPT = [
  "You are a clue-giver in Just One, the cooperative word game.",
  "A human guesser has to name a secret word from the clues. You are writing ONE clue for it.",
  "Two other players are writing their clue for the SAME word at the SAME time.",
  "You cannot see their clues and they cannot see yours — nobody writes second.",
  "Before the guesser sees anything, a referee compares all three clues and CANCELS every clue that matches another player's.",
  "A cancelled clue is struck out and never shown, so it helps the guesser exactly as much as writing nothing.",
  "Therefore the best clue is accurate but NOT the single most obvious word: predict what the other two are most likely to write, and approach the secret from an angle they probably will not take. Do not be so obscure that the guesser cannot use it.",
  "Rules the referee enforces mechanically: exactly one word, no spaces or hyphens; never the secret word itself or an inflection of it; matching clues cancel.",
  "Decide privately what the others will likely write, then return only your clue word — no explanation.",
].join(" ");

const agentSetup = setupAgent({
  schemas: justOneSchemas,
  models,
  requests: {
    // ONE request definition, used by all three regions. Its input type is the
    // isolation guarantee in miniature: `{ secretWord, persona }` and nothing
    // else — there is no field a sibling's clue could travel in.
    writeClue: {
      schemas: {
        input: z.object({ secretWord: z.string(), persona: personaSchema }),
        output: clueDraftSchema,
      },
      model: "clueGiver",
      system: CLUE_SYSTEM_PROMPT,
      prompt: ({ input }) =>
        [
          `Secret word: ${input.secretWord}`,
          `You are ${input.persona.name}. Your angle: ${input.persona.angle}.`,
          "Write your one-word clue.",
        ].join("\n"),
    },
  },
});

export const justOneMachine = agentSetup.createMachine({
  id: "just-one",
  context: ({ input }) => ({
    deck: input.deck ?? [...WORD_DECK],
    roundIndex: 0,
    rounds: input.rounds,
    clueA: null,
    clueB: null,
    clueC: null,
    clues: [],
    score: 0,
    log: [],
  }),
  output: ({ context }) => ({
    summary: narrate(context),
    score: context.score,
    rounds: context.rounds,
  }),
  initial: "pickingWord",
  states: {
    // Deal the round: its secret word is the deck card at `roundIndex` (see
    // `secretWordOf`), so there is nothing to copy — just clear last round's
    // judged clues.
    pickingWord: {
      always: { target: "cluing", context: { clues: [] } },
    },

    // Three simultaneous clue-givers. Each region invokes the SAME `writeClue`
    // request with a different persona, and every input is built from
    // `{ secretWord, persona }` at region entry — before any sibling request
    // settles, so no clue can be in scope to leak. Each region writes only its
    // own slot; `judging` is the first place all three are read together.
    cluing: {
      type: "parallel",
      onDone: { target: "judging" },
      states: {
        giverA: {
          initial: "writing",
          states: {
            writing: {
              invoke: {
                src: "writeClue",
                input: ({ context }) => ({
                  secretWord: secretWordOf(context),
                  persona: PERSONAS[0],
                }),
                onDone: ({ output }) => ({ target: "written", context: { clueA: output.result } }),
                // A failed request is a blank clue: the round goes on, and
                // `judgeClues` strikes it like any other unusable clue.
                onError: { target: "written", context: { clueA: null } },
              },
            },
            written: { type: "final" },
          },
        },
        giverB: {
          initial: "writing",
          states: {
            writing: {
              invoke: {
                src: "writeClue",
                input: ({ context }) => ({
                  secretWord: secretWordOf(context),
                  persona: PERSONAS[1],
                }),
                onDone: ({ output }) => ({ target: "written", context: { clueB: output.result } }),
                onError: { target: "written", context: { clueB: null } },
              },
            },
            written: { type: "final" },
          },
        },
        giverC: {
          initial: "writing",
          states: {
            writing: {
              invoke: {
                src: "writeClue",
                input: ({ context }) => ({
                  secretWord: secretWordOf(context),
                  persona: PERSONAS[2],
                }),
                onDone: ({ output }) => ({ target: "written", context: { clueC: output.result } }),
                onError: { target: "written", context: { clueC: null } },
              },
            },
            written: { type: "final" },
          },
        },
      },
    },

    // The rulebook, applied in one pure step. If every clue was struck the
    // guesser is never shown anything — the round is skipped, as in the real
    // game — so `guessing` is not even entered.
    //
    // The drafts are cleared here (a struck draft may be the secret itself)
    // and the struck clues are kept face down, so the idle guessing snapshot
    // holds nothing that gives the word away.
    judging: {
      always: ({ context }) => {
        const clues = faceDown(
          judgeClues(secretWordOf(context), [context.clueA, context.clueB, context.clueC]),
        );
        const drafts = { clueA: null, clueB: null, clueC: null };

        if (survivors(clues).length === 0) {
          return {
            target: "roundEnd",
            context: {
              ...drafts,
              clues,
              log: [
                ...context.log,
                roundLine({ ...context, clues }),
                "All clues cancelled — round skipped.",
              ],
            },
          };
        }
        return { target: "guessing", context: { ...drafts, clues } };
      },
    },

    // No invoke: the run settles idle here and a host resumes it with `GUESS`
    // (free text) or the `PASS` button.
    guessing: {
      tags: ["waiting"],
      meta: {
        interaction: {
          // Derived at read time from the judged clues, so no rendered copy of
          // them has to be kept in context and in sync.
          label: ({ context }: { context: JustOneContext }) =>
            `Clues: ${survivors(context.clues)
              .map((clue) => clue.word)
              .join(", ")}. What is the secret word?`,
          events: {
            GUESS: { label: "Guess", style: "primary" },
            PASS: { label: "Pass" },
          },
          textEvent: "GUESS",
        },
      },
      on: {
        GUESS: ({ context, event }) => {
          const secretWord = secretWordOf(context);
          const correct = isCorrectGuess(event.guess, secretWord);
          return {
            target: "roundEnd",
            context: {
              score: context.score + (correct ? 1 : 0),
              log: [
                ...context.log,
                roundLine(context),
                correct
                  ? `Guessed "${event.guess.trim()}" — correct.`
                  : `Guessed "${event.guess.trim()}" — wrong, the word was "${secretWord}".`,
              ],
            },
          };
        },
        PASS: ({ context }) => ({
          target: "roundEnd",
          context: {
            log: [
              ...context.log,
              roundLine(context),
              `Passed — the word was "${secretWordOf(context)}".`,
            ],
          },
        }),
      },
    },

    roundEnd: {
      always: ({ context }) =>
        context.roundIndex + 1 < context.rounds
          ? { target: "pickingWord", context: { roundIndex: context.roundIndex + 1 } }
          : { target: "gameOver" },
    },

    gameOver: { type: "final" },
  },
});

// ─── Host helpers ───

type JustOneSnapshot = SnapshotFrom<typeof justOneMachine>;

/** What a host sends to unblock an idle machine. */
export type GuesserEvent = { type: "GUESS"; guess: string } | { type: "PASS" };

/** The label a host shows on an idle guessing turn. */
export function idlePrompt(snapshot: JustOneSnapshot): string {
  return getInteraction(snapshot)?.label ?? "What is the secret word?";
}

/** Route free text to the idle state's `textEvent` (or `PASS` for "pass"). */
export function toGuesserEvent(text: string): GuesserEvent {
  return text.trim().toLowerCase() === "pass" ? { type: "PASS" } : { type: "GUESS", guess: text };
}

// ─── Dual-mode entrypoint ───

export async function main() {
  const shared = { executors: createAiSdkExecutors({ models }) };

  let result = await runToQuiescence(
    createAgentRuntime(justOneMachine, {
      ...shared,
    }),
    {
      input: { rounds: 3 },
      ...shared,
    },
  );

  // Every guessing turn settles the run idle. Resume from `result.persist()`.
  while (result.status === "idle") {
    const text = await promptLine(`${idlePrompt(result.snapshot)}\n> `);
    result = await runToQuiescence(
      createAgentRuntime(justOneMachine, {
        ...shared,
      }),
      {
        snapshot: result.persist(),
        event: toGuesserEvent(text),
        ...shared,
      },
    );
  }

  if (result.status !== "done") throw new Error(`Just One did not complete: ${result.status}`);
  console.log(result.output.summary);
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
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
