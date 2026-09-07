/**
 * The Chameleon — hidden-role deduction where the secret is withheld by the
 * *shape of a request input*, not by an instruction in a prompt.
 *
 * Four AI players each say ONE word about a secret word from a known category.
 * Three of them know the secret. The fourth — the chameleon — knows only the
 * category, and has to blend in by inferring the secret from what has already
 * been said. The human is the detective: watch the round, accuse a player, and
 * if the accusation lands the chameleon gets one guess at the secret to steal
 * the win.
 *
 * Two properties this example exists to show:
 *
 *   1. Asymmetric information is structural. `sayWord` takes a UNION input: a
 *      knowing player's turn is built as
 *      `{ knowsSecret: true, category, secretWord, wordsSoFar, position }`,
 *      and the chameleon's turn as
 *      `{ knowsSecret: false, category, wordsSoFar, position }` — there is no
 *      `secretWord` field on that branch for the secret to travel in. Nothing
 *      redacts or masks it; the request the chameleon's model call receives
 *      cannot contain it. `index.test.ts` regression-tests exactly that by
 *      deep-stringifying every captured request.
 *
 *      The bluff still lives in the model: the chameleon is told there is a
 *      secret word it does not have, and must reason from prior words to say
 *      something plausibly specific. It just never gets the word.
 *
 *   2. Turn order is sequential and machine-owned. Unlike `just-one`, where
 *      isolation means writing in parallel, here each player must SEE the words
 *      said before them — so `clueRound` is a loop of one request at a time,
 *      appending to a single `words` array from a single state. `wordsSoFar` is
 *      therefore exactly the public record at that player's position, and the
 *      chameleon's advantage of speaking later is a fact about the graph.
 *
 * The vote is an idle state (no invoke) carrying `meta.interaction`: the
 * category and the four spoken words in the label, and one `ACCUSE { seat }`
 * event the host fills in with the seat you name. Resume with
 * `runAgent(machine, { snapshot: result.persist(), event })`.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/chameleon/index.ts
 */
import { z } from "zod";
import type { SnapshotFrom } from "xstate";
import { openai } from "@ai-sdk/openai";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";
import {
  createAgentSchemas,
  getInteraction,
  interactionMetaSchema,
  runAgent,
  setupAgent,
} from "@statelyai/agent";

/** The table, in speaking order. Index doubles as the player's seat. */
export const PLAYERS = ["Ada", "Bruno", "Cleo", "Dev"] as const;

const spokenWordSchema = z.object({
  player: z.string(),
  word: z.string(),
  reasoning: z.string(),
});
type SpokenWord = z.infer<typeof spokenWordSchema>;

const wordDraftSchema = z.object({
  word: z.string(),
  reasoning: z.string(),
});

const guessDraftSchema = z.object({
  guess: z.string(),
  reasoning: z.string(),
});

/** The public record a player sees on their turn: who spoke, and what. */
const publicWordSchema = z.object({ player: z.string(), word: z.string() });

const outcomeSchema = z.enum(["detectives-win", "chameleon-steals", "chameleon-escapes"]);
type Outcome = z.infer<typeof outcomeSchema>;

const chameleonContextSchema = z.object({
  category: z.string(),
  secretWord: z.string(),
  chameleonIndex: z.number(),
  /** Seat order with roles resolved from `chameleonIndex`. */
  players: z.array(z.object({ name: z.string(), isChameleon: z.boolean() })),
  /** Whose turn it is in `clueRound`; also the index into `players`. */
  turnIndex: z.number(),
  /** Append-only, written by one state at a time — the round IS this array. */
  words: z.array(spokenWordSchema),
  /** Seat the detective accused; `null` until the vote is in. */
  accusedIndex: z.number().nullable(),
  log: z.array(z.string()),
});

type ChameleonContext = z.infer<typeof chameleonContextSchema>;

export const chameleonSchemas = createAgentSchemas({
  // The library's own interaction protocol, not a per-machine restatement.
  meta: interactionMetaSchema,
  context: chameleonContextSchema,
  input: z.object({
    category: z.string().default("Ocean creatures"),
    secretWord: z.string().default("octopus"),
    /** Which seat is the chameleon. Fixed, so a run is fully reproducible. */
    chameleonIndex: z.number().int().min(0).max(3).default(2),
  }),
  output: z.object({
    /** Headline: a readable narration of the whole game. */
    summary: z.string(),
    outcome: outcomeSchema,
    chameleon: z.string(),
    secretWord: z.string(),
    accused: z.string(),
    words: z.array(spokenWordSchema),
    log: z.array(z.string()),
  }),
  events: {
    /** The detective's one move: name the seat you suspect. */
    ACCUSE: z.object({
      seat: z
        .number()
        .int()
        .min(0)
        .max(PLAYERS.length - 1),
    }),
  },
});

const models = defineModels({ player: openai("gpt-5.4-mini") });

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

/**
 * The forms a word is allowed to match in: itself, plus a naive de-inflection.
 * Comparing form SETS (rather than one canonical key) makes "octopuses" match
 * "octopus" without also having to know that "octopus" is not itself a plural.
 */
function wordForms(raw: string): string[] {
  const word = normalizeWord(raw);
  if (word.length > 3 && word.endsWith("es")) return [word, word.slice(0, -2)];
  if (word.length > 3 && word.endsWith("s")) return [word, word.slice(0, -1)];
  return [word];
}

/** `true` when the chameleon's steal attempt names the secret word. */
export function isCorrectGuess(guess: string, secretWord: string): boolean {
  const secretForms = wordForms(secretWord);
  if (secretForms[0] === "") return false;
  return wordForms(guess).some((form) => form !== "" && secretForms.includes(form));
}

/** Roles are a pure function of the seat the chameleon was dealt. */
export function assignRoles(chameleonIndex: number) {
  return PLAYERS.map((name, index) => ({ name, isChameleon: index === chameleonIndex }));
}

/** What a player at `position` is allowed to see: everything said before them. */
function publicRecord(words: SpokenWord[]) {
  return words.map(({ player, word }) => ({ player, word }));
}

function renderWords(words: SpokenWord[]): string {
  return words.map(({ player, word }) => `${player}: ${word || "(silent)"}`).join(", ");
}

/** The seat's player name, or "nobody" before the vote is in. */
function seatName(seat: number | null): string {
  return seat === null ? "nobody" : (PLAYERS[seat] ?? "nobody");
}

/**
 * The finished game, as each final state reports it. The OUTCOME IS THE STATE:
 * it is passed in by whichever final state was reached, never stored in context
 * and read back.
 */
function finishGame(context: ChameleonContext, outcome: Outcome) {
  const chameleon = seatName(context.chameleonIndex);
  const headline =
    outcome === "detectives-win"
      ? `Detectives win. ${chameleon} was the chameleon and could not name "${context.secretWord}".`
      : outcome === "chameleon-steals"
        ? `Chameleon steals it. ${chameleon} was caught, then named "${context.secretWord}".`
        : `Chameleon escapes. ${chameleon} was the chameleon; you accused ${seatName(context.accusedIndex)}.`;
  return {
    summary: `${headline}\n\n${context.log.join("\n")}`,
    outcome,
    chameleon: PLAYERS[context.chameleonIndex] ?? "",
    secretWord: context.secretWord,
    accused: context.accusedIndex === null ? "" : (PLAYERS[context.accusedIndex] ?? ""),
    words: context.words,
    log: context.log,
  };
}

// ─── Agent ───

const KNOWING_SYSTEM_PROMPT = [
  "You are a player in The Chameleon, a hidden-role party game.",
  "Everyone at the table sees the category. You and two other players also know the SECRET WORD; one player does not — that player is the chameleon, and is trying to blend in.",
  "On your turn you say exactly ONE word related to the secret word. Players speak in order and hear every word said before them.",
  "Your word has to walk a line: specific enough that the other knowing players believe you know the secret, vague enough that the chameleon cannot deduce the secret from it.",
  "Saying the secret word, a spelling of it, or something that only makes sense for it hands the chameleon the game. Saying something that fits the whole category equally well makes YOU look like the chameleon.",
  "Never mention the secret word itself. Reason briefly, then commit to one word.",
].join(" ");

const CHAMELEON_SYSTEM_PROMPT = [
  "You are the CHAMELEON in The Chameleon, a hidden-role party game.",
  "You know the category. You do NOT know the secret word — it was never given to you, and you cannot ask for it.",
  "Three other players know it. On your turn you must say exactly ONE word and pass as one of them.",
  "Use the words already said to infer what the secret might be, then say something plausibly specific for that guess.",
  "Too vague and you look like someone covering for not knowing; too specific and you are wrong out loud. If you speak early with little to go on, pick a word that stays defensible across several candidate secrets.",
  "After everyone has spoken the table votes. Reason briefly, then commit to one word.",
].join(" ");

const agentSetup = setupAgent({
  schemas: chameleonSchemas,
  models,
  requests: {
    /**
     * ONE request definition for all four players. Its input is a union, and
     * the union IS the hidden-role rule: the `knowsSecret: false` branch has no
     * `secretWord` field, so the chameleon's turn cannot carry the secret even
     * by mistake. The prompt narrows on the discriminant.
     */
    sayWord: {
      schemas: {
        input: z.union([
          z.object({
            knowsSecret: z.literal(true),
            category: z.string(),
            secretWord: z.string(),
            wordsSoFar: z.array(publicWordSchema),
            position: z.number(),
          }),
          z.object({
            knowsSecret: z.literal(false),
            category: z.string(),
            wordsSoFar: z.array(publicWordSchema),
            position: z.number(),
          }),
        ]),
        output: wordDraftSchema,
      },
      model: "player",
      system: ({ input }) => (input.knowsSecret ? KNOWING_SYSTEM_PROMPT : CHAMELEON_SYSTEM_PROMPT),
      prompt: ({ input }) =>
        [
          `Category: ${input.category}`,
          input.knowsSecret
            ? `Secret word: ${input.secretWord}`
            : "You do not know the secret word.",
          `You speak ${input.position} of ${PLAYERS.length}.`,
          input.wordsSoFar.length === 0
            ? "Nobody has spoken yet."
            : `Said so far — ${input.wordsSoFar.map((entry) => `${entry.player}: ${entry.word}`).join(", ")}`,
          "Say your one word.",
        ].join("\n"),
    },

    /**
     * The caught chameleon's one shot. It finally sees all four words — still
     * never the secret — and names what it thinks the secret was.
     */
    guessSecret: {
      schemas: {
        input: z.object({
          category: z.string(),
          words: z.array(publicWordSchema),
        }),
        output: guessDraftSchema,
      },
      model: "player",
      system: [
        "You are the chameleon in The Chameleon, and you have just been caught by the vote.",
        "You get one guess at the secret word. Name it and you steal the win outright; miss and the detectives take it.",
        "You never learned the secret word. All you have is the category and the four words said at the table — three of them by players who knew it.",
        "Weigh the words the others said against each other: the secret is the thing all three were circling. Answer with a single word.",
      ].join(" "),
      prompt: ({ input }) =>
        [
          `Category: ${input.category}`,
          `Words said: ${input.words.map((entry) => `${entry.player}: ${entry.word}`).join(", ")}`,
          "What was the secret word?",
        ].join("\n"),
    },
  },
});

export const chameleonMachine = agentSetup.createMachine({
  id: "chameleon",
  context: ({ input }) => ({
    category: input.category,
    secretWord: input.secretWord,
    chameleonIndex: input.chameleonIndex,
    players: assignRoles(input.chameleonIndex),
    turnIndex: 0,
    words: [],
    accusedIndex: null,
    log: [],
  }),
  initial: "dealing",
  states: {
    // Roles are dealt once, deterministically, from the input seat.
    dealing: {
      always: ({ context }) => ({
        target: "clueRound",
        context: {
          log: [
            `Category: ${context.category}. One of ${PLAYERS.join(", ")} does not know the secret word.`,
          ],
        },
      }),
    },

    // Sequential turns: exactly one `sayWord` request is in flight at a time,
    // and each one is built from the words already appended. The chameleon's
    // input is a different shape from everyone else's — see `sayWord`.
    clueRound: {
      initial: "turn",
      onDone: { target: "voting" },
      states: {
        turn: {
          invoke: {
            src: "sayWord",
            input: ({ context }) => {
              const shared = {
                category: context.category,
                wordsSoFar: publicRecord(context.words),
                position: context.turnIndex + 1,
              };
              return context.players[context.turnIndex]?.isChameleon
                ? { knowsSecret: false as const, ...shared }
                : { knowsSecret: true as const, secretWord: context.secretWord, ...shared };
            },
            onDone: ({ context, output }) => ({
              target: "advancing",
              context: {
                words: [
                  ...context.words,
                  {
                    player: PLAYERS[context.turnIndex] ?? "",
                    word: output.word.trim(),
                    reasoning: output.reasoning,
                  },
                ],
              },
            }),
            // A failed request is a silent player: the round goes on, and the
            // empty word is simply weak evidence for the detective.
            onError: ({ context }) => ({
              target: "advancing",
              context: {
                words: [
                  ...context.words,
                  { player: PLAYERS[context.turnIndex] ?? "", word: "", reasoning: "" },
                ],
              },
            }),
          },
        },
        advancing: {
          always: ({ context }) =>
            context.turnIndex + 1 < PLAYERS.length
              ? { target: "turn", context: { turnIndex: context.turnIndex + 1 } }
              : {
                  target: "spoken",
                  context: { log: [...context.log, `Words — ${renderWords(context.words)}.`] },
                },
        },
        spoken: { type: "final" },
      },
    },

    // No invoke: the run settles idle here and a host resumes it with ONE
    // `ACCUSE` event naming the seat.
    voting: {
      tags: ["waiting"],
      meta: {
        interaction: {
          // A function of the context: the spoken words are rendered here, not
          // kept as a second copy in context.
          label: ({ context }) =>
            `Category: ${context.category}. ${renderWords(context.words)}. ` +
            `Who is the chameleon? (${PLAYERS.map((name, seat) => `${seat}=${name}`).join(", ")})`,
          events: { ACCUSE: { label: "Accuse this seat" } },
        },
      },
      on: {
        ACCUSE: ({ context, event }) => ({
          target: "reveal",
          context: {
            accusedIndex: event.seat,
            log: [...context.log, `You accused ${PLAYERS[event.seat]}.`],
          },
        }),
      },
    },

    // The reveal is a branch on context, not an entry action: the accusation
    // either lands (the chameleon gets its steal attempt) or it does not.
    reveal: {
      always: ({ context }) =>
        context.accusedIndex === context.chameleonIndex
          ? {
              target: "chameleonGuessing",
              context: {
                log: [
                  ...context.log,
                  `Caught — ${PLAYERS[context.chameleonIndex]} was the chameleon, and gets one guess at the secret word.`,
                ],
              },
            }
          : {
              target: "chameleonEscapes",
              context: {
                log: [
                  ...context.log,
                  `Wrong — ${PLAYERS[context.chameleonIndex]} was the chameleon and walks away with it. The secret word was "${context.secretWord}".`,
                ],
              },
            },
    },

    chameleonGuessing: {
      invoke: {
        src: "guessSecret",
        input: ({ context }) => ({
          category: context.category,
          words: publicRecord(context.words),
        }),
        // The comparison is the machine's, not the model's: a normalized match
        // against the secret the request never received.
        onDone: ({ context, output }) => {
          const guess = output.guess.trim();
          const correct = isCorrectGuess(guess, context.secretWord);
          return {
            target: correct ? "chameleonSteals" : "detectivesWin",
            context: {
              log: [
                ...context.log,
                correct
                  ? `${PLAYERS[context.chameleonIndex]} guessed "${guess}" — right, and steals the win.`
                  : `${PLAYERS[context.chameleonIndex]} guessed "${guess}" — wrong. The secret word was "${context.secretWord}".`,
              ],
            },
          };
        },
        onError: ({ context }) => ({
          target: "detectivesWin",
          context: {
            log: [
              ...context.log,
              `${PLAYERS[context.chameleonIndex]} had no guess. The secret word was "${context.secretWord}".`,
            ],
          },
        }),
      },
    },

    // Three terminals, three outcomes. Which state the game ended in IS the
    // outcome; nothing mirrors it in context.
    detectivesWin: {
      type: "final",
      output: ({ context }) => finishGame(context, "detectives-win"),
    },
    chameleonSteals: {
      type: "final",
      output: ({ context }) => finishGame(context, "chameleon-steals"),
    },
    chameleonEscapes: {
      type: "final",
      output: ({ context }) => finishGame(context, "chameleon-escapes"),
    },
  },
});

// ─── Host helpers ───

type ChameleonSnapshot = SnapshotFrom<typeof chameleonMachine>;

/** What a host sends to unblock the idle vote. */
export type AccuseEvent = { type: "ACCUSE"; seat: number };

/** The label a host shows on the idle vote. */
export function idlePrompt(snapshot: ChameleonSnapshot): string {
  return getInteraction(snapshot)?.label ?? "Who is the chameleon?";
}

/** Free text ("cleo", "2", "player 3") to an accusation, if it names a seat. */
export function toAccuseEvent(text: string): AccuseEvent | undefined {
  const trimmed = normalizeWord(text);
  const byName = PLAYERS.findIndex((name) => normalizeWord(name) === trimmed);
  const seat = byName >= 0 ? byName : Number.parseInt(trimmed.replace(/[^0-9]/g, ""), 10);
  return seat >= 0 && seat < PLAYERS.length ? { type: "ACCUSE", seat } : undefined;
}

// ─── Dual-mode entrypoint ───

export async function main() {
  const shared = { executors: createAiSdkExecutors({ models }) };

  let result = await runAgent(chameleonMachine, {
    input: { category: "Ocean creatures", secretWord: "octopus", chameleonIndex: 2 },
    ...shared,
  });

  // The vote settles the run idle. Resume from `result.persist()`.
  while (result.status === "idle") {
    const text = await promptLine(`${idlePrompt(result.snapshot)}\n> `);
    const event = toAccuseEvent(text);
    if (!event) {
      console.log("Name a player or a seat number.");
      continue;
    }
    result = await runAgent(chameleonMachine, {
      snapshot: result.persist(),
      event,
      ...shared,
    });
  }

  if (result.status !== "done") throw new Error(`Chameleon did not complete: ${result.status}`);
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
