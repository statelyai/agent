/**
 * Twenty Questions — decision loop + guard-enforced legality + human turns as
 * gated machine events.
 *
 * The agent asks yes/no questions to narrow down a secret, then guesses.
 * Showcases:
 *   - Inline `agent.decide` invoke (chosen event auto-delivered): the model picks
 *     exactly one currently-legal event (ASK or GUESS) each turn. The
 *     decision is authored state-local — it lives in the `deciding` state
 *     that invokes it, typed against the machine's own event schemas.
 *   - Guard-enforced legality: the final turn must be GUESS, so ASK is
 *     only legal while `questionsRemaining > 1` (a v6 function-transition
 *     returning `undefined` when illegal). If the model chooses ASK on the
 *     final turn, `resolveDecision`'s mode-3 `canTake` check rejects it
 *     (`failure: 'rejected-by-guard'`) and retries.
 *   - Human turns as idle states with `meta.interaction` hints. States waiting
 *     on the player have no invoke, so the run settles `idle`; the hints tell a
 *     host which buttons to render (`ANSWER_YES` / `ANSWER_NO`, …) and which
 *     event free chat text becomes (`textEvent`). Labels interpolate
 *     `{question}` against the snapshot context, so the button row is captioned
 *     with whatever the agent just asked. Resume with
 *     `runAgent(machine, { snapshot: result.persistedSnapshot, event })`.
 *   - Two paths into the same state: button events are deterministic (no model
 *     call), free text goes through a classifier request instead.
 *   - Side-question detour: the player's free-text reply to a yes/no question
 *     may itself be a question ("is a lizard considered domestic?").
 *     `classifyAnswer` returns a discriminated union — a yes/no answer OR a side
 *     question — and the side-question branch answers it (without revealing the
 *     secret), emits the answer (`SIDE_ANSWER`), and re-asks the SAME pending
 *     question. No turn is consumed and the transcript entry is untouched.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/twenty-questions/index.ts
 */
import { z } from "zod";
import type { SnapshotFrom } from "xstate";
import { openai } from "@ai-sdk/openai";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";
import {
  type AgentMessage,
  assistantMessage,
  createAgentSchemas,
  getStateMeta,
  runAgent,
  setupAgent,
  userMessage,
} from "@statelyai/agent";

const transcriptTurnSchema = z.object({
  question: z.string(),
  answer: z.enum(["yes", "no"]),
  rawAnswer: z.string(),
});

// Three-way classification of the player's reply: a yes/no answer, or a side
// question asked back at the agent. A plain `z.union` (not
// `z.discriminatedUnion`) emits `anyOf`, which OpenAI structured output
// accepts where it rejects `oneOf`.
const answerClassificationSchema = z.union([
  z.object({
    kind: z.literal("answer"),
    answer: z.enum(["yes", "no"]),
    reasoning: z.string(),
  }),
  z.object({
    kind: z.literal("sideQuestion"),
    question: z.string(),
    reasoning: z.string(),
  }),
]);

const guessFeedbackClassificationSchema = z.object({
  correct: z.boolean(),
  reasoning: z.string(),
});

const models = defineModels({
  quick: openai("gpt-5.4-mini"),
});

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

export const twentyQuestionsSchemas = createAgentSchemas({
  meta: metaSchema,
  context: z.object({
    /** What the agent is currently waiting on; `{question}` in idle labels. */
    question: z.string(),
    maxQuestions: z.number(),
    questionsRemaining: z.number(),
    transcript: z.array(transcriptTurnSchema),
    messages: z.custom<AgentMessage[]>((v) => Array.isArray(v)),
    pendingRawAnswer: z.string().nullable(),
    pendingSideQuestion: z.string().nullable(),
    guess: z.string().nullable(),
    userScore: z.number(),
    agentScore: z.number(),
    round: z.number(),
  }),
  input: z.object({
    questionsRemaining: z.number().default(20),
  }),
  output: z.object({
    guess: z.string(),
    questionsUsed: z.number(),
    userScore: z.number(),
    agentScore: z.number(),
    roundsPlayed: z.number(),
  }),
  events: {
    ASK: z.object({ question: z.string() }),
    GUESS: z.object({ guess: z.string() }),
    /** Free-text player replies (the `textEvent` of each idle state). */
    ANSWER: z.object({ rawAnswer: z.string() }),
    GUESS_FEEDBACK: z.object({ rawAnswer: z.string() }),
    PLAY_AGAIN: z.object({ rawAnswer: z.string() }),
    /** Button replies: deterministic, no classifier call. */
    ANSWER_YES: z.object({}),
    ANSWER_NO: z.object({}),
    GUESS_RIGHT: z.object({}),
    GUESS_WRONG: z.object({}),
    PLAY_AGAIN_YES: z.object({}),
    PLAY_AGAIN_NO: z.object({}),
  },
  emitted: {
    // The agent's brief answer to a player's side question, surfaced so the
    // host can print it before the pending question is re-asked.
    SIDE_ANSWER: z.object({ question: z.string(), answer: z.string() }),
  },
});

const agentSetup = setupAgent({
  schemas: twentyQuestionsSchemas,
  models,
  // Deterministic idle detection: the states waiting on the player are exactly
  // the ones tagged `waiting`, so runAgent does not fall back to its timing
  // heuristic.
  isSuspended: (snapshot) => snapshot.hasTag("waiting"),
  requests: {
    classifyAnswer: {
      schemas: {
        input: z.object({
          question: z.string(),
          rawAnswer: z.string(),
          messages: z.custom<AgentMessage[]>((v) => Array.isArray(v)),
          transcript: z.array(transcriptTurnSchema),
        }),
        output: answerClassificationSchema,
      },
      model: "quick",
      system:
        "Classify a natural-language reply to a Twenty Questions yes/no question. " +
        'Return kind=answer with answer=yes for affirmations like "mhm", "for sure", "correct", or indirect confirmations, ' +
        "and answer=no for denials, corrections, or contradictions. " +
        "Return kind=sideQuestion (with the question text) when the reply is itself a question " +
        'asked back at you — e.g. "is a lizard considered domestic?" — instead of a yes/no answer. ' +
        "Keep reasoning short.",
      messages: ({ input }) => [
        ...input.messages,
        userMessage(
          [
            `Question: ${input.question}`,
            `Raw answer: ${input.rawAnswer}`,
            "Classify the raw answer as a yes/no answer or a side question.",
          ].join("\n"),
        ),
      ],
    },
    answerSideQuestion: {
      schemas: {
        input: z.object({
          question: z.string(),
          transcript: z.array(transcriptTurnSchema),
        }),
        output: z.string(),
      },
      model: "quick",
      system:
        "The Twenty Questions player asked you a side question instead of answering yes/no. " +
        "Answer it briefly and factually in one sentence, using the transcript for context. " +
        "Do NOT reveal, speculate about, or hint at what the secret might be — the game " +
        "continues after your answer.",
      prompt: ({ input }) =>
        [
          "Transcript so far:",
          input.transcript.length === 0
            ? "(none yet)"
            : input.transcript.map((turn) => `Q: ${turn.question}\nA: ${turn.answer}`).join("\n"),
          `Side question: ${input.question}`,
        ].join("\n"),
    },
    classifyGuessFeedback: {
      schemas: {
        input: z.object({
          guess: z.string(),
          rawAnswer: z.string(),
          messages: z.custom<AgentMessage[]>((v) => Array.isArray(v)),
        }),
        output: guessFeedbackClassificationSchema,
      },
      model: "quick",
      system:
        "Classify whether the user says the Twenty Questions guess was correct. " +
        "Return correct=true for yes/correct/right. Return correct=false for no/wrong/incorrect.",
      messages: ({ input }) => [
        ...input.messages,
        userMessage(
          [
            `Guess: ${input.guess}`,
            `Raw answer: ${input.rawAnswer}`,
            "Classify whether the guess was correct.",
          ].join("\n"),
        ),
      ],
    },
    classifyPlayAgain: {
      schemas: {
        input: z.object({
          rawAnswer: z.string(),
          messages: z.custom<AgentMessage[]>((v) => Array.isArray(v)),
        }),
        output: z.object({
          playAgain: z.boolean(),
          reasoning: z.string(),
        }),
      },
      model: "quick",
      system:
        "Classify whether the user wants to play another round. Return playAgain=true for yes; false for no.",
      messages: ({ input }) => [
        ...input.messages,
        userMessage(
          [
            "Question: Do you want to play another round?",
            `Raw answer: ${input.rawAnswer}`,
            "Classify whether the user wants another round.",
          ].join("\n"),
        ),
      ],
    },
  },
  // Only `gameOver` is narrowed. The only transition into it is
  // classifyingPlayAgain's onDone (playAgain=false), reached only after a GUESS
  // event already set `guess` — guaranteed non-null there. Every other state is
  // left at the base context: partial `states` means unlisted states keep it,
  // and states whose reset transitions write `guess`/`pendingSideQuestion` back
  // to null cannot be narrowed (a narrowed source can't widen a field).
  states: {
    gameOver: { context: { guess: z.string() } },
  },
});

function renderTranscriptPrompt(context: {
  questionsRemaining: number;
  transcript: { question: string; answer: "yes" | "no"; rawAnswer: string }[];
  messages: AgentMessage[];
}): string {
  return [
    `Questions remaining: ${context.questionsRemaining}`,
    `Messages so far: ${JSON.stringify(context.messages)}`,
    "Transcript so far:",
    context.transcript.length === 0
      ? "(none yet)"
      : context.transcript
          .map(
            (turn) =>
              `Q: ${turn.question}\nA: ${turn.answer}` +
              (turn.rawAnswer ? ` (raw: ${turn.rawAnswer})` : ""),
          )
          .join("\n"),
    "If the player reveals the secret or gives extra information in a raw answer, use it and guess immediately.",
    "Avoid repeating categories already answered. If something is an animal, do not ask if it is a plant, fungus, or microorganism.",
    context.questionsRemaining > 1
      ? "Ask a yes/no question (ASK) or make your guess (GUESS)."
      : "This is the final turn. You must make your guess now (GUESS).",
  ].join("\n");
}

const PLAY_AGAIN_PROMPT = "Do you want to play another round?";

/**
 * Append the pending question to the transcript, now that it has an answer.
 * The pending question lives in `context.question` until then, so an unanswered
 * question never shows up as history.
 */
function withAnswer(
  context: {
    question: string;
    transcript: { question: string; answer: "yes" | "no"; rawAnswer: string }[];
    messages: AgentMessage[];
  },
  answer: "yes" | "no",
  rawAnswer: string,
) {
  return {
    transcript: [...context.transcript, { question: context.question, answer, rawAnswer }],
    messages: [...context.messages, userMessage(rawAnswer)],
    pendingRawAnswer: null,
  };
}

/** Apply guess feedback to the score and queue the play-again prompt. */
function withGuessFeedback(
  context: { agentScore: number; userScore: number; messages: AgentMessage[] },
  correct: boolean,
  rawAnswer: string,
) {
  return {
    agentScore: context.agentScore + (correct ? 1 : 0),
    userScore: context.userScore + (correct ? 0 : 1),
    messages: [...context.messages, userMessage(rawAnswer), assistantMessage(PLAY_AGAIN_PROMPT)],
    pendingRawAnswer: null,
    question: PLAY_AGAIN_PROMPT,
  };
}

/** Reset for another round; scores and round count carry over. */
function freshRound(context: { maxQuestions: number; round: number }) {
  return {
    questionsRemaining: context.maxQuestions,
    transcript: [],
    messages: [],
    pendingRawAnswer: null,
    pendingSideQuestion: null,
    guess: null,
    question: "",
    round: context.round + 1,
  };
}

export const twentyQuestionsMachine = agentSetup.createMachine({
  id: "twenty-questions",
  context: ({ input }) => ({
    question: "",
    maxQuestions: input.questionsRemaining,
    questionsRemaining: input.questionsRemaining,
    transcript: [],
    messages: [],
    pendingRawAnswer: null,
    pendingSideQuestion: null,
    guess: null,
    userScore: 0,
    agentScore: 0,
    round: 1,
  }),
  initial: "deciding",
  states: {
    deciding: {
      invoke: {
        src: "agent.decide",
        input: ({ context }) => ({
          model: "quick",
          system:
            "You are playing twenty questions. Ask one yes/no question at a time to " +
            "narrow down the secret, or guess once you are confident. You have a " +
            "limited number of questions remaining.",
          prompt: renderTranscriptPrompt(context),
          maxRetries: 2,
        }),
        onError: { target: "stumped" },
      },
      on: {
        // Guard: ASK is only legal before the final turn. Returning
        // `undefined` makes the transition illegal — `snapshot.can(event)`
        // (resolveDecision's mode-3 check) will reject an ASK chosen with
        // one turn remaining, recording `failure: 'rejected-by-guard'` and
        // retrying. The model must GUESS on the final turn.
        ASK: ({ context, event }) =>
          context.questionsRemaining > 1
            ? {
                target: "awaitingAnswer",
                context: {
                  // The pending question stays out of `transcript` until the
                  // player actually answers it.
                  question: event.question,
                  messages: [...context.messages, assistantMessage(event.question)],
                  questionsRemaining: context.questionsRemaining - 1,
                },
              }
            : undefined,
        GUESS: ({ context, event }) => ({
          target: "awaitingGuessFeedback",
          context: {
            guess: event.guess,
            question: `My guess is ${event.guess}. Was I right?`,
            messages: [
              ...context.messages,
              assistantMessage(`My guess is ${event.guess}. Was I right?`),
            ],
          },
        }),
      },
    },

    // No invoke: the run settles idle here and a host resumes with one of the
    // accepted events. Buttons answer directly; free text goes to ANSWER and
    // gets classified (which is also how side questions are detected).
    awaitingAnswer: {
      tags: ["waiting"],
      meta: {
        interaction: {
          label: "{question}",
          events: {
            ANSWER_YES: { label: "Yes", style: "primary" },
            ANSWER_NO: { label: "No" },
            ANSWER: { label: "Reply" },
          },
          textEvent: "ANSWER",
        },
      },
      on: {
        ANSWER_YES: ({ context }) => ({
          target: "deciding",
          context: withAnswer(context, "yes", "yes"),
        }),
        ANSWER_NO: ({ context }) => ({
          target: "deciding",
          context: withAnswer(context, "no", "no"),
        }),
        ANSWER: ({ event }) => ({
          target: "classifyingAnswer",
          context: { pendingRawAnswer: event.rawAnswer },
        }),
      },
    },

    classifyingAnswer: {
      invoke: {
        src: "classifyAnswer",
        input: ({ context }) => ({
          question: context.question,
          rawAnswer: context.pendingRawAnswer ?? "",
          messages: context.messages,
          transcript: context.transcript,
        }),
        onDone: ({ context, output }) =>
          output.kind === "sideQuestion"
            ? {
                // Detour: answer the player's side question, then re-ask the
                // SAME pending question. The transcript entry and turn count
                // are untouched.
                target: "answeringSideQuestion",
                context: {
                  pendingSideQuestion: output.question,
                  pendingRawAnswer: null,
                },
              }
            : {
                target: "deciding",
                context: withAnswer(context, output.answer, context.pendingRawAnswer ?? ""),
              },
        onError: { target: "stumped" },
      },
    },

    answeringSideQuestion: {
      invoke: {
        src: "answerSideQuestion",
        input: ({ context }) => ({
          question: context.pendingSideQuestion ?? "",
          transcript: context.transcript,
        }),
        onDone: ({ context, output }, enq) => {
          // Surface the answer to the host, then return to the pending
          // question — awaitingAnswer re-prompts with the same transcript
          // entry, so no turn is consumed.
          enq.emit({
            type: "SIDE_ANSWER",
            question: context.pendingSideQuestion ?? "",
            answer: output,
          });
          return {
            target: "awaitingAnswer",
            context: {
              pendingSideQuestion: null,
              messages: [
                ...context.messages,
                userMessage(context.pendingSideQuestion ?? ""),
                assistantMessage(output),
              ],
            },
          };
        },
        // If the side answer fails, just re-ask the pending question.
        onError: {
          target: "awaitingAnswer",
          context: { pendingSideQuestion: null },
        },
      },
    },

    awaitingGuessFeedback: {
      tags: ["waiting"],
      meta: {
        interaction: {
          label: "{question}",
          events: {
            GUESS_RIGHT: { label: "Got it", style: "primary" },
            GUESS_WRONG: { label: "Nope", style: "danger" },
            GUESS_FEEDBACK: { label: "Reply" },
          },
          textEvent: "GUESS_FEEDBACK",
        },
      },
      on: {
        GUESS_RIGHT: ({ context }) => ({
          target: "awaitingPlayAgain",
          context: withGuessFeedback(context, true, "correct"),
        }),
        GUESS_WRONG: ({ context }) => ({
          target: "awaitingPlayAgain",
          context: withGuessFeedback(context, false, "wrong"),
        }),
        GUESS_FEEDBACK: ({ event }) => ({
          target: "classifyingGuessFeedback",
          context: { pendingRawAnswer: event.rawAnswer },
        }),
      },
    },

    classifyingGuessFeedback: {
      invoke: {
        src: "classifyGuessFeedback",
        input: ({ context }) => ({
          guess: context.guess ?? "",
          rawAnswer: context.pendingRawAnswer ?? "",
          messages: context.messages,
        }),
        onDone: ({ context, output }) => ({
          target: "awaitingPlayAgain",
          context: withGuessFeedback(context, output.correct, context.pendingRawAnswer ?? ""),
        }),
        onError: {
          target: "awaitingPlayAgain",
          context: { question: PLAY_AGAIN_PROMPT },
        },
      },
    },

    awaitingPlayAgain: {
      tags: ["waiting"],
      meta: {
        interaction: {
          label: "{question}",
          events: {
            PLAY_AGAIN_YES: { label: "Play again", style: "primary" },
            PLAY_AGAIN_NO: { label: "Stop here" },
            PLAY_AGAIN: { label: "Reply" },
          },
          textEvent: "PLAY_AGAIN",
        },
      },
      on: {
        PLAY_AGAIN_YES: ({ context }) => ({
          target: "deciding",
          context: freshRound(context),
        }),
        PLAY_AGAIN_NO: ({ context }) => ({
          target: "gameOver",
          context: {
            messages: [...context.messages, userMessage("no")],
            pendingRawAnswer: null,
            guess: context.guess ?? "",
          },
        }),
        PLAY_AGAIN: ({ event }) => ({
          target: "classifyingPlayAgain",
          context: { pendingRawAnswer: event.rawAnswer },
        }),
      },
    },

    classifyingPlayAgain: {
      invoke: {
        src: "classifyPlayAgain",
        input: ({ context }) => ({
          rawAnswer: context.pendingRawAnswer ?? "",
          messages: context.messages,
        }),
        onDone: ({ context, output }) =>
          output.playAgain
            ? { target: "deciding", context: freshRound(context) }
            : {
                target: "gameOver",
                context: {
                  messages: [...context.messages, userMessage(context.pendingRawAnswer ?? "")],
                  pendingRawAnswer: null,
                  // Prove gameOver's narrowing: a GUESS always preceded this state.
                  guess: context.guess ?? "",
                },
              },
        onError: ({ context }) => ({
          target: "gameOver",
          context: { guess: context.guess ?? "" },
        }),
      },
    },

    gameOver: {
      type: "final",
      output: ({ context }) => ({
        guess: context.guess,
        questionsUsed: context.transcript.length,
        userScore: context.userScore,
        agentScore: context.agentScore,
        roundsPlayed: context.round,
      }),
    },

    // Reached when chooseAction exhausts its retries (AgentDecisionExhaustedError).
    stumped: {
      type: "final",
      output: ({ context }) => ({
        guess: "",
        questionsUsed: context.transcript.length,
        userScore: context.userScore,
        agentScore: context.agentScore,
        roundsPlayed: context.round,
      }),
    },
  },
});

const executors = createAiSdkExecutors({ models });

type TwentyQuestionsSnapshot = SnapshotFrom<typeof twentyQuestionsMachine>;

/** What a host (or the test) sends to unblock an idle machine. */
export type PlayerEvent =
  | { type: "ANSWER_YES" }
  | { type: "ANSWER_NO" }
  | { type: "GUESS_RIGHT" }
  | { type: "GUESS_WRONG" }
  | { type: "PLAY_AGAIN_YES" }
  | { type: "PLAY_AGAIN_NO" }
  | { type: "ANSWER"; rawAnswer: string }
  | { type: "GUESS_FEEDBACK"; rawAnswer: string }
  | { type: "PLAY_AGAIN"; rawAnswer: string };

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

/** Prompt for whatever the idle state is waiting on, from its meta hint. */
export function idlePrompt(snapshot: TwentyQuestionsSnapshot): string {
  const interaction = getStateMeta(snapshot).interaction;
  return resolveInteractionLabel(interaction?.label ?? "?", snapshot.context);
}

/** Route free text to the idle state's `textEvent`. */
export function toPlayerEvent(snapshot: TwentyQuestionsSnapshot, text: string): PlayerEvent {
  const textEvent = getStateMeta(snapshot).interaction?.textEvent ?? "ANSWER";
  return { type: textEvent, rawAnswer: text } as PlayerEvent;
}

export async function main() {
  const shared = {
    executors,
    on: {
      SIDE_ANSWER: ({ answer }: { answer: string }) => console.log(`[side answer] ${answer}`),
    },
    onTransition: (snapshot: TwentyQuestionsSnapshot) =>
      console.log("[state]", JSON.stringify(snapshot.value)),
  };

  let result = await runAgent(twentyQuestionsMachine, {
    input: { questionsRemaining: 20 },
    ...shared,
  });

  // Every player turn settles the run idle. Resume from `persistedSnapshot`.
  while (result.status === "idle") {
    const text = await promptLine(`${idlePrompt(result.snapshot)}\n> `);
    result = await runAgent(twentyQuestionsMachine, {
      snapshot: result.persistedSnapshot,
      event: toPlayerEvent(result.snapshot, text),
      ...shared,
    });
  }

  if (result.status !== "done") {
    throw new Error(`Twenty questions did not complete: ${result.status}`);
  }

  console.log(`Final score — user: ${result.output.userScore}, agent: ${result.output.agentScore}`);
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
